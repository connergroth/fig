/**
 * Approval bridge. A specialist runs as its own scoped sub-query, so its canUseTool
 * can't reach the live Conversation's askOwner directly. The Conversation registers
 * its approver here for the duration of a turn; specialist sub-queries route
 * sensitive-action confirmations (send an email, delete an event, buy something)
 * through it, so the 🔐 still lands on the owner's phone. Unattended runs (the
 * scheduler) register no approver, so those sensitive actions are denied.
 */

/**
 * Extras the SYSTEM attaches to a 🔐 alongside the question text. Deliberately not
 * model-authored and not model-visible — no agent surface can set these; they're filled in by
 * whatever bridge raised the prompt, so an enriched prompt is a property of the code path and
 * never a judgment call.
 */
export interface ApprovalPrompt {
  /**
   * Absolute path to an image to send WITH the prompt, so the owner can see the state they're
   * approving instead of approving blind. Set by approvalScreenshot.ts, for browser/desktop
   * approvals only. Strictly best-effort: if it's missing/unreadable the prompt goes out as
   * plain text and the approval is otherwise untouched.
   */
  imagePath?: string;
  /**
   * A DEFERRED system-built preview image, resolved by whoever sends the prompt and handed the
   * 🔐's minted id. Two reasons it's a callback rather than a path:
   *
   *   - the id is minted at send time (session.ts), and the rendered approval card has to carry
   *     the SAME `#a3f` tag as its text bubble — otherwise two stacked cards in scrollback are
   *     just as indistinguishable as the two identical text bubbles that bug was about.
   *   - it keeps an expensive render (a headless-Chrome screenshot) off the path entirely when
   *     the prompt turns out not to be sent at all.
   *
   * Same contract as `imagePath` otherwise: strictly best-effort, resolves null on any failure,
   * and the approval proceeds as plain text. If both are set, `imagePath` wins.
   */
  image?: (id: string) => Promise<string | null>;
}

export type Approver = (question: string, prompt?: ApprovalPrompt) => Promise<boolean>;

let active: Approver | null = null;

export function setApprover(fn: Approver | null): void {
  active = fn;
}

/**
 * Snapshot the live approver RIGHT NOW. Synchronous specialists (email/calendar/music)
 * run inside the turn and use requestApproval directly. But a fully-async background job
 * (browse/code) outlives the turn that launched it — by the time it needs a 🔐, the turn
 * has ended and `active` is back to null, so requestApproval would silently auto-deny and
 * The owner never sees a prompt. Those jobs grab this snapshot AT LAUNCH (still in-turn) and
 * carry it for their whole life. The Conversation's askOwner is a persistent method that
 * can prompt the owner any time, so the snapshot keeps working after the turn ends. A job
 * launched unattended (scheduler → no approver) snapshots null and stays denied.
 */
export function currentApprover(): Approver | null {
  return active;
}

/** Ask the active conversation's owner to approve; deny if nobody's attending. */
export async function requestApproval(question: string, prompt?: ApprovalPrompt): Promise<boolean> {
  return active ? active(question, prompt) : false;
}
