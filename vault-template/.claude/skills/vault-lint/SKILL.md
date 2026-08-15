---
name: vault-lint
description: >-
  The vault's contract verifier — proves every folder and note type is in spec against its own written contract, auto-fixing mechanical violations and flagging the judgment calls. The engine `dream` invokes on its weekly sweep; also run on demand when the owner says "lint the vault", "verify the vault", "check the contracts", or "is the vault in spec". Returns a structured report and does NOT text the owner (dream owns the message). Structure, contracts and cross-folder consistency only — it does not consolidate memory or touch skills.
---

# vault-lint (contract verifier)

The point of this skill: **the owner never has to read the vault to know its
state.** Each shaped folder carries a `SCHEMA.md` (a folder-contract) ending in
a `## Checks` block — the machine-checkable encoding of that folder's rules.
vault-lint reads those checks and proves each folder is in spec. n contracts,
one verifier.

Core principle, inherited from dream: **conservative.** Apply only the `[auto]`
fixes (safe, mechanical, reversible). Everything tagged `[flag]` is a judgment
call — surface it with a recommendation, never apply it. Numbers, prose
meaning, and deletions are never auto-changed.

This skill is the *engine*. It returns its findings to the caller (usually
`dream`, which merges them into the weekly text). When run on demand, hand the
same structured result back to the main agent to relay.

## How a folder-contract works

A contract is any `SCHEMA.md` with `type: folder-contract` in its frontmatter.
Its `## Checks` section lists rules, each tagged:
- `[auto]` — mechanical and safe. Fix it in place and record what you fixed.
- `[flag]` — a judgment call. Record it with a recommendation; do not apply it.

A checker validates a folder by reading **only** that folder's `## Checks`
block plus the folder's files. That self-containment is what lets the folders
be checked independently / in parallel.

## The sweep (run in order)

### 1. Discover the contracts
Contracts come in two kinds and both are discovered as data, never hardcoded:

- **Folder-contracts** — `find . -name SCHEMA.md`, keep those whose frontmatter
  is `type: folder-contract`. Their scope is a path. The template ships one
  (`System/Reference/SCHEMA.md`); the vault grows more as folders earn a shape.
- **Type-contracts** — `grep -rl "^type: type-contract"` (the template ships
  `System/Policies/hub-contract.md`). Their scope is a frontmatter selector,
  not a path, because the type lives spread across the vault. The contract's
  `applies_to:` field names the selector (e.g. `frontmatter type: hub`);
  resolve it to a file set with a grep and check that set.

Both kinds end in a `## Checks` block in the identical tagged format, and both
are verified the same way in step 2. A type-contract is just a contract whose
scope is `grep`-resolved instead of `ls`-resolved.

### 2. Per-scope verification — fan out, one checker per contract
For each contract, run an INDEPENDENT check (parallelize when the runtime can
spawn subagents; otherwise walk them in sequence — the result is the same
because each check is self-contained):
- Read that contract's `## Checks` block.
- **If the contract names a script, run it** rather than re-deriving its checks
  by hand (the hub contract ships
  `.claude/skills/vault-lint/scripts/hub-check.py`). A script's output is the
  finding; still apply the `[auto]` fixes and judge the `[flag]`s yourself.
- Walk its file set — the folder's files for a folder-contract, the
  `applies_to:` selector's matches for a type-contract — and evaluate each
  rule.
- For every `[auto]` rule: fix violations in place (rename a misnamed file, add
  a missing required frontmatter field, correct a POV slip per the convention).
  Record each fix as one line.
- For every `[flag]` rule: collect the violation + the contract's
  recommendation. Do not act.
- Produce a per-scope result: `{scope, autofixed: [...], flagged: [...],
  clean: bool}`.

Never invent a check the contract doesn't state, and never "fix" something a
contract marks `[flag]`. The contract is the law for its scope; if a rule is
wrong, the fix is to edit the contract (an owner/main-agent decision), not to
freelance here.

### 3. Meta-check — is the contract system itself intact?
This is the guarantee that the "never read the vault" promise holds. Run once:
- **Every shaped folder has a contract.** For each folder that has real,
  drift-prone shape, confirm a `SCHEMA.md` exists. If a clearly-shaped folder
  has no contract, `[flag]` it ("folder X has structure but no SCHEMA.md"). Do
  NOT auto-author a contract — that's a deliberate act. Append-log /
  dated-dump folders (`System/Conversations/`, `System/reflect/`,
  `System/Reviews/`) are intentionally contract-free; do not flag them for
  lacking one.
- **Every contract maps to a real scope.** For each `SCHEMA.md`, confirm its
  `folder:` exists. For each type-contract, confirm its `applies_to:` selector
  matches at least one file — a brand-new vault legitimately has zero hubs, so
  an empty selector is only a `[flag]` once the vault has real content.
- **README documents every folder.** Diff `find . -type d` (minus dotdirs)
  against the folders listed in `README.md`. A folder missing from README → add
  a routing line `[auto]` (route it per the nearest section); a README entry
  for a folder that no longer exists → `[flag]`.
- **README points at each contract.** Confirm README's folder line for a
  contracted folder notes it has a `SCHEMA.md`. Add the pointer `[auto]` if
  missing. (Routing stays sole-sourced in README; the contract never restates
  routing.)
- **No second copy of the folder map, anywhere.** README is the SOLE owner of
  the vault map (per its own header). Any other always-loaded root file that
  grows a folder-by-folder index — `CLAUDE.md`, `Owner.md`, `SOUL.md` — is a
  duplicate that will drift → `[flag]` it for deletion, don't reconcile it.
  Never auto-sync a second index into another file; two hand-kept copies of one
  map is the bug this check exists to prevent.
- **The four root files each answer exactly one question.** `Owner.md` =
  durable facts about the owner. `SOUL.md` = how the agent acts. `README.md` =
  where things live. `Memory.md` = how memory works. `CLAUDE.md` = only the
  always-loaded contract (the `@Owner.md` import + pointers), never facts or
  rules of its own. A line answering another file's question → `[flag]` with
  the line quoted and the file it belongs in.
- **`CLAUDE.md`'s import actually resolves.** Confirm `CLAUDE.md` still
  contains a line-initial `@Owner.md` and that `Owner.md` exists at the vault
  root. If the import line is missing or the target moved, the owner's identity
  silently stops being loaded on every turn → `[flag]` LOUDLY; this one is not
  cosmetic.
- **Sync-conflict scan.** `find . -iname "*sync-conflict*"` anywhere (including
  `.claude/skills/`). Any hit is a sync artifact that a glob loader might
  wrongly read → `[flag]` with "safe to delete after the owner confirms".

### 4. Cross-folder consistency (run once, by the coordinator)
The checks a single folder can't see on its own:
- **One canonical home (per Memory.md).** The same durable fact living in two
  places — e.g. a fact in both a skill's operational `references/` and a topic
  note, or a person fact duplicated across `People/` and `Owner.md`. `[flag]`
  with the canonical home + recommendation to stub-and-link the other.
- **POV across all knowledge files.** Enforce README's writing convention.
  Knowledge files are third person about the owner; instruction files are
  second person to the agent. Fix the clear slips `[auto]`, `[flag]` anything
  where the rewrite could change meaning.
- **Dead internal links / stale paths.** Spot-check that `[[wikilinks]]` and
  explicit vault paths referenced inside notes point at files that exist.
  `[flag]` dead ones with the corrected path.
- **Contradictions.** Where the same subject is asserted two ways across
  folders (a status that says both "ordered" and "delivered"), `[flag]` the
  contradiction for the owner.

### 5. Return the result
Hand back a structured result the caller renders:
```
{
  folders:   [ {folder, autofixed[], flagged[], clean} ... ],
  meta:      { autofixed[], flagged[] },
  crossref:  { autofixed[], flagged[] },
  clean:     bool   // true only if nothing was flagged anywhere
}
```
Append a one-line entry per run to `.state/vault-lint-log.md` (create if
absent): date, # folders checked, # auto-fixed, # flagged. That log is the
audit trail proving the sweep ran — it is the only thing the owner should ever
need to glance at.

## Scope boundary
vault-lint does STRUCTURE, CONTRACTS, and CONSISTENCY. It does NOT consolidate
or promote memory, clear todos/loops, or touch skills/`references/` wiring —
that janitor work stays in `dream`, which calls this skill and owns the text to
the owner. If a check would require changing a skill's logic or a contract's
rules, flag it; don't act.
