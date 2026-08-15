/**
 * Unit checks for the proactive output-contract validator (src/chunking.ts).
 * Run: node --import tsx --test scripts/tests/output-contract.test.ts
 */
import assert from "node:assert/strict";

import { isQuietOutput, isQuietSentinel, isSilence, isValidProactiveOutput, OUTPUT_CONTRACT, SILENCE_TOKEN } from "../../src/render/chunking";

const LEAK = 'Pruned the queue and sent. Here\'s the brief:\n\nmorning. demo day. email: quiet.';

const cases: Array<[string, boolean]> = [
  // the actual leak string, no wrapper → INVALID (this is the whole point)
  [`leak prose, no wrapper (quiet contract)`, isValidProactiveOutput(LEAK, OUTPUT_CONTRACT.quiet) === false],
  [`leak prose, no wrapper (wrapped contract)`, isValidProactiveOutput(LEAK, OUTPUT_CONTRACT.wrapped) === false],
  [`leak prose, no wrapper (watch contract)`, isValidProactiveOutput(LEAK, OUTPUT_CONTRACT.watch) === false],
  [`leak prose, no wrapper (goal contract)`, isValidProactiveOutput(LEAK, OUTPUT_CONTRACT.goal) === false],

  // well-formed <output> → VALID for every contract
  [`wrapped message (quiet)`, isValidProactiveOutput("<output>hey, you're good for wings</output>", OUTPUT_CONTRACT.quiet) === true],
  [`wrapped message (wrapped)`, isValidProactiveOutput("<output>research is in</output>", OUTPUT_CONTRACT.wrapped) === true],
  [`wrapped with narration around it`, isValidProactiveOutput("ok done. <output>your brief</output> sent it", OUTPUT_CONTRACT.quiet) === true],

  // watch: wrapped + trailing RESOLVED → VALID
  [`watch wrapped + RESOLVED`, isValidProactiveOutput("<output>the package arrived</output>\nRESOLVED", OUTPUT_CONTRACT.watch) === true],
  // bare RESOLVED (resolved, nothing to say) → VALID
  [`bare RESOLVED`, isValidProactiveOutput("RESOLVED", OUTPUT_CONTRACT.watch) === true],

  // goal: bare CONTINUE (silent pass) → VALID
  [`bare CONTINUE`, isValidProactiveOutput("CONTINUE", OUTPUT_CONTRACT.goal) === true],
  [`goal wrapped + DONE`, isValidProactiveOutput("<output>here's the finished plan</output>\nDONE", OUTPUT_CONTRACT.goal) === true],
  // prose + bare CONTINUE, no wrapper → INVALID (leak case, must be caught)
  [`prose + CONTINUE, no wrapper`, isValidProactiveOutput("here's an update on the goal\nCONTINUE", OUTPUT_CONTRACT.goal) === false],
  // CONTINUE is not a valid bare token for a watch contract
  [`bare CONTINUE under watch contract`, isValidProactiveOutput("CONTINUE", OUTPUT_CONTRACT.watch) === false],

  // quiet NOTHING sentinel → VALID where allowed, INVALID where not
  [`NOTHING (quiet)`, isValidProactiveOutput("NOTHING", OUTPUT_CONTRACT.quiet) === true],
  [`reasoning then trailing NOTHING (quiet)`, isValidProactiveOutput("nothing actionable here\nNOTHING", OUTPUT_CONTRACT.quiet) === true],
  [`NOTHING under wrapped-only contract`, isValidProactiveOutput("NOTHING", OUTPUT_CONTRACT.wrapped) === false],

  // empty → treated as valid (caller handles as quiet/failed, not a leak)
  [`empty string`, isValidProactiveOutput("", OUTPUT_CONTRACT.wrapped) === true],

  // --- mustContain (newspaper contract): a well-formed wrapper is NOT enough — the
  // delivered payload must carry the paper link. Without it, a "done, paper sent" status
  // line wrapped in <output> passes the bare wrapper check and ships INSTEAD of the paper.
  // With it, that fails validation and re-prompts.
  [
    `newspaper: wrapped status line WITHOUT the link → INVALID`,
    isValidProactiveOutput("<output>done. paper's filed, rendered, tl;dr already sent</output>", OUTPUT_CONTRACT.newspaper) === false,
  ],
  [
    `newspaper: wrapped tl;dr WITH the link → VALID`,
    isValidProactiveOutput("<output>📰 newspaper · fri 7/17\n\n3 fresh drops today\n\nopen-page.cc/paper</output>", OUTPUT_CONTRACT.newspaper) === true,
  ],
  [
    `newspaper: link match is case-insensitive`,
    isValidProactiveOutput("<output>the read's up at OPEN-PAGE.CC/PAPER</output>", OUTPUT_CONTRACT.newspaper) === true,
  ],
  [
    `newspaper: dated link (open-page.cc/paper/2026-07-17) still contains the token → VALID`,
    isValidProactiveOutput("<output>today's paper: open-page.cc/paper/2026-07-17</output>", OUTPUT_CONTRACT.newspaper) === true,
  ],
  // a no-news day is still allowed to go quiet under the newspaper contract
  [`newspaper: bare NOTHING (no-news day) → VALID`, isValidProactiveOutput("NOTHING", OUTPUT_CONTRACT.newspaper) === true],
  [`newspaper: reasoning then trailing NOTHING → VALID`, isValidProactiveOutput("nothing new worth a paper today\nNOTHING", OUTPUT_CONTRACT.newspaper) === true],
  // sanity: the plain quiet contract has NO mustContain, so the same link-less wrapper passes
  [
    `quiet contract (no mustContain): link-less wrapper still VALID`,
    isValidProactiveOutput("<output>done. paper's filed, tl;dr sent</output>", OUTPUT_CONTRACT.quiet) === true,
  ],

  // --- isQuietOutput. isValidProactiveOutput treats ANY well-formed
  // <output>...</output> block as valid without inspecting its contents (see the
  // hasWrappedOutput short-circuit above) — so a model that wraps its own quiet
  // sentinel instead of leaving it bare produces text that (a) passes contract
  // validation and (b) fails a raw isQuietSentinel check, since the raw text isn't
  // bare NOTHING. Only unwrapping THEN checking catches it — that's isQuietOutput.
  [`bare NOTHING is quiet`, isQuietOutput("NOTHING") === true],
  [`wrapped NOTHING is quiet (the shape that leaks)`, isQuietOutput("<output>NOTHING</output>") === true],
  [`wrapped nothing, mixed case`, isQuietOutput("<output>Nothing</output>") === true],
  [`wrapped NOTHING with narration around it`, isQuietOutput("thinking...\n<output>NOTHING</output>\nok done") === true],
  [`raw isQuietSentinel MISSES the wrapped form (why isQuietOutput exists)`, isQuietSentinel("<output>NOTHING</output>") === false],
  [`wrapped real message is NOT quiet`, isQuietOutput("<output>hey, the flight's back down to $220</output>") === false],
  [`unwrapped prose is NOT quiet`, isQuietOutput("just texting to say hi") === false],
  [`empty is NOT quiet (caller treats empty separately)`, isQuietOutput("") === false],

  // --- isSilence: the live-session gate (SILENCE_TOKEN OR any quiet sentinel, bare only —
  // isSilence intentionally does NOT call isQuietOutput/unwrap, since live replies are
  // never expected to carry an <output> wrapper in the first place).
  [`SILENCE_TOKEN is silence`, isSilence(SILENCE_TOKEN) === true],
  [`SILENCE_TOKEN, different case/whitespace`, isSilence(`  ${SILENCE_TOKEN.toUpperCase()}  `) === true],
  [`bare NOTHING is silence`, isSilence("NOTHING") === true],
  [`real reply is not silence`, isSilence("on it, sec") === false],
];

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) {
    failed++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok:   ${name}`);
  }
}
assert.equal(failed, 0, `${failed} case(s) failed`);
console.log(`\nall ${cases.length} cases passed`);
