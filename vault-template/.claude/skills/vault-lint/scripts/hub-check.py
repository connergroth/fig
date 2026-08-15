#!/usr/bin/env python3
"""Mechanical checks for the hub type-contract (System/Policies/hub-contract.md).

Run from the vault root:  python3 .claude/skills/vault-lint/scripts/hub-check.py

Checks, per hub (a note with `type: hub` in frontmatter):
  - required frontmatter: name / type / domain / updated
  - required sections: ## Snapshot, ## Recent, ## People
  - Snapshot as-of date matches `updated`
  - freshness: newest mtime across `domain:` globs vs `updated` (>3d = stale)
  - completeness: every domain note reachable from the hub within ONE hop
  - broken wikilinks
  - domain overlap between hubs
Plus, vault-wide: hub candidates (a domain with 3+ notes, touched in the last
30 days, that no hub claims).

Prints a report and exits non-zero if anything is violated. Judgment calls are
labelled [flag] — this script never edits a file.
"""
import re, os, glob, sys, datetime
from collections import defaultdict

TODAY = datetime.date.today()
STALE_DAYS = 3
CANDIDATE_MIN_NOTES = 3
CANDIDATE_ACTIVE_DAYS = 30
# machine-layer + append-log folders never hold or earn a hub
NEVER = ("System/", "Daily/", ".claude/")
# folders governed by other means (contracts, being lists) — never hub candidates
NOT_CANDIDATES = (".", "Lists", "People", "Travel", "Wiki",
                  "Work", "Career", "Projects", "Finance", "Health")
# flat shared folders where a hub covers a name-prefix group, not the whole dir
FLAT_GROUP_DIRS = ("Work", "Career", "Projects")

def read(p):
    try: return open(p, errors="ignore").read()
    except OSError: return ""

def frontmatter(txt):
    m = re.match(r"^---\n(.*?)\n---", txt, re.S)
    return m.group(1) if m else ""

def all_notes():
    return [p for p in glob.glob("**/*.md", recursive=True)
            if not p.startswith(".git")]

def find_hubs():
    out = []
    for p in all_notes():
        if p.startswith(NEVER): continue
        if re.search(r"^type:\s*hub\s*$", frontmatter(read(p)), re.M):
            out.append(p)
    return sorted(out)

def domain_files(hub, fm):
    globs = re.findall(r'^\s+-\s+"?(!?[^"\n]+?)"?\s*$', fm, re.M)
    inc = [g for g in globs if not g.startswith("!")]
    exc = [g[1:] for g in globs if g.startswith("!")]
    files = set()
    for g in inc: files |= set(glob.glob(g, recursive=True))
    for g in exc: files -= set(glob.glob(g, recursive=True))
    files.discard(hub)
    return files, bool(inc)

def wikilinks(p):
    return {l.strip() for l in re.findall(r"\[\[([^\]|#]+)", read(p))}

_resolve_cache = {}
def resolve(link):
    if link in _resolve_cache: return _resolve_cache[link]
    cands = glob.glob(link + ".md") or glob.glob(
        "**/" + os.path.basename(link) + ".md", recursive=True)
    _resolve_cache[link] = cands[0] if cands else None
    return _resolve_cache[link]

def mdate(p):
    return datetime.date.fromtimestamp(os.path.getmtime(p))

def main():
    hubs = find_hubs()
    if not hubs:
        # a young vault legitimately has no hubs yet — that's in spec, not an error
        print("no hubs found (fine for a new vault — is this the vault root?)")
        return 0
    violations = []
    claimed = defaultdict(list)

    for hub in hubs:
        txt = read(hub); fm = frontmatter(txt)
        print(f"\n{hub}")
        for field in ("name:", "type:", "domain:", "updated:"):
            if not re.search(rf"^{field}", fm, re.M):
                violations.append(f"{hub}: [auto] missing frontmatter `{field}`")
        m = re.search(r"^updated:\s*(\d{4}-\d{2}-\d{2})", fm, re.M)
        updated = datetime.date.fromisoformat(m.group(1)) if m else None
        if updated and updated > TODAY:
            violations.append(f"{hub}: [auto] `updated` is in the future")

        for sec in ("## Snapshot", "## Recent", "## People"):
            if sec not in txt:
                violations.append(f"{hub}: [auto] missing required section `{sec}`")

        asof = re.search(r"## Snapshot \(as of (\d{4}-\d{2}-\d{2})\)", txt)
        if asof and updated and asof.group(1) != str(updated):
            violations.append(
                f"{hub}: [auto] Snapshot as-of {asof.group(1)} != updated {updated}")

        files, has_inc = domain_files(hub, fm)
        if not has_inc:
            violations.append(f"{hub}: [auto] `domain:` has no include globs")
            continue
        if not files:
            violations.append(f"{hub}: [flag] orphan hub — `domain:` matches no files")
            continue
        for f in files: claimed[f].append(hub)

        newest = max(files, key=os.path.getmtime)
        nd = mdate(newest)
        if updated and (nd - updated).days > STALE_DAYS:
            violations.append(
                f"{hub}: [flag] STALE — {newest} moved {nd}, hub says {updated}")
        print(f"  domain: {len(files)} notes · newest {newest} ({nd}) · updated {updated}")

        direct = wikilinks(hub)
        reach = set()
        for l in direct:
            r = resolve(l)
            if not r: continue
            reach.add(r)
            for l2 in wikilinks(r):
                r2 = resolve(l2)
                if r2: reach.add(r2)
        unreachable = [f for f in sorted(files) if f not in reach]
        for f in unreachable:
            violations.append(f"{hub}: [flag] unreachable in 1 hop — {f}")
        broken = [l for l in sorted(direct) if not resolve(l)]
        for l in broken:
            violations.append(f"{hub}: [flag] broken wikilink — [[{l}]]")
        n = len(txt.splitlines())
        if n > 250:
            violations.append(f"{hub}: [flag] detail creep — {n} lines (>250)")
        print(f"  unreachable: {len(unreachable)} · broken links: {len(broken)} · {n} lines")

    for f, owners in claimed.items():
        if len(owners) > 1:
            violations.append(f"[flag] domain overlap — {f} claimed by {owners}")

    # hub candidates: a folder with 3+ notes, active recently, unclaimed.
    # A folder is NOT a candidate if a hub already claims anything in it (the
    # unclaimed leftovers are deliberate `!` exclusions), or if it sits under a
    # folder-contract (SCHEMA.md) — that folder is governed, just not by a hub.
    touched = {os.path.dirname(f) for f in claimed} | {os.path.dirname(h) for h in hubs}
    contracted = {os.path.dirname(s) for s in glob.glob("**/SCHEMA.md", recursive=True)}
    by_dir = defaultdict(list)
    for p in all_notes():
        if p.startswith(NEVER) or p in claimed: continue
        d = os.path.dirname(p) or "."
        if d in touched or any(d == c or d.startswith(c + "/") for c in contracted):
            continue
        by_dir[d].append(p)
    cutoff = TODAY - datetime.timedelta(days=CANDIDATE_ACTIVE_DAYS)
    cands = []
    for d, ps in sorted(by_dir.items()):
        if d in NOT_CANDIDATES: continue
        if len(ps) < CANDIDATE_MIN_NOTES: continue
        if max(mdate(p) for p in ps) < cutoff: continue
        cands.append((d, len(ps)))
    # flat-folder candidates: a shared folder where N notes share a name prefix
    for d in FLAT_GROUP_DIRS:
        groups = defaultdict(list)
        for p in glob.glob(f"{d}/*.md"):
            if p in claimed: continue
            groups[os.path.basename(p).split("-")[0].replace(".md", "")].append(p)
        for stem, ps in groups.items():
            if len(ps) >= CANDIDATE_MIN_NOTES and max(mdate(p) for p in ps) >= cutoff:
                cands.append((f"{d}/{stem}*", len(ps)))
    for d, n in cands:
        violations.append(f"[flag] hub candidate — {d} ({n} notes, active) has no hub")

    print("\n" + "=" * 60)
    if not violations:
        print("all hubs in spec"); return 0
    for v in violations: print(" · " + v)
    print(f"\n{len(violations)} violation(s)")
    return 1

if __name__ == "__main__":
    sys.exit(main())
