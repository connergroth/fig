import assert from "node:assert/strict";

import { toWellFormedUnicode, truncateUnicode } from "./unicode";

assert.equal(toWellFormedUnicode("plain text"), "plain text");
assert.equal(toWellFormedUnicode("valid 👍 emoji"), "valid 👍 emoji");
assert.equal(toWellFormedUnicode("cut high \ud83d"), "cut high \ufffd");
assert.equal(toWellFormedUnicode("orphan low \udc4d"), "orphan low \ufffd");
assert.equal(toWellFormedUnicode("\ud83dA\udc4d"), "\ufffdA\ufffd");

const repaired = toWellFormedUnicode('[Reacted 👍 to "changes delivery address? \ud83d"]');
assert.equal(repaired, '[Reacted 👍 to "changes delivery address? \ufffd"]');
assert.doesNotThrow(() => JSON.parse(JSON.stringify({ prompt: repaired })));
assert.equal(truncateUnicode(`${"a".repeat(79)}👍tail`, 80), `${"a".repeat(79)}👍`);
assert.equal(truncateUnicode(`bad\ud83d`, 80), "bad\ufffd");

console.log("unicode: all checks passed");
