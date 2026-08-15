import assert from "node:assert/strict";

// OWNER_ALIASES is computed from OWNER_EMAILS at module load, so the env must be set
// BEFORE owner.ts loads — hence the lazy import inside main(). node --test gives this
// file its own process, so the override can't leak into other tests.
process.env.OWNER_EMAILS = " Owner@Example.COM, second@example.com ,,";

async function main(): Promise<void> {
  const { parseOwnerEmails, OWNER_ALIASES, isOwnerOrAlias } = await import("./owner");

  // Parsing: trimmed, lowercased, blanks dropped. The exact-match contract depends on
  // normalization happening here, once — not at each call site.
  assert.deepEqual(parseOwnerEmails(" Owner@Example.COM, second@example.com ,,"), [
    "owner@example.com",
    "second@example.com",
  ]);
  assert.deepEqual(parseOwnerEmails(undefined), []);
  assert.deepEqual(parseOwnerEmails(""), []);

  assert.deepEqual([...OWNER_ALIASES], ["owner@example.com", "second@example.com"]);

  // iMessage varies the casing/whitespace of the delivering handle; a stranger's
  // different address must never match.
  assert.equal(isOwnerOrAlias("owner@example.com "), true);
  assert.equal(isOwnerOrAlias("second@example.com"), true);
  assert.equal(isOwnerOrAlias("stranger@example.com"), false);
  assert.equal(isOwnerOrAlias(""), false);

  console.log("owner: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
