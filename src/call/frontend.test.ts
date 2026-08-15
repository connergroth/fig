import assert from "node:assert/strict";

import { callChildLaunch, resolveCallFrontend, rustCallChildBinary } from "./frontend";

// --- front-end selection: local is the default, realtime stays reachable ---
assert.equal(resolveCallFrontend({}), "local", "default is the local front-end");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: "" }), "local");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: "local" }), "local");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: "realtime" }), "realtime", "the fallback flag still works");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: "REALTIME" }), "realtime", "case-insensitive");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: " realtime " }), "realtime", "trimmed");
assert.equal(resolveCallFrontend({ CALL_FRONTEND: "gibberish" }), "local", "unknown values fail toward the real brain");

// --- child launch: local = the Rust binary, realtime = the TypeScript child ---
assert.equal(rustCallChildBinary({ CALL_RUST_CHILD_BIN: "/tmp/custom-child" }), "/tmp/custom-child");
assert.ok(rustCallChildBinary({}).endsWith("/tools/call/child/target/release/fig-call-child"));

const local = callChildLaunch("local", ["--hold"], { CALL_RUST_CHILD_BIN: "/tmp/fig-call-child" });
assert.deepEqual(local, {
  frontend: "local",
  command: "/tmp/fig-call-child",
  args: ["--hold"],
});

const realtime = callChildLaunch("realtime", ["--hold"], {});
assert.equal(realtime.frontend, "realtime");
assert.equal(realtime.command, process.execPath);
assert.deepEqual(realtime.args.slice(0, 2), ["--import", "tsx"]);
assert.ok(realtime.args[2].endsWith("/src/call/realtimeSessionChild.ts"));
assert.equal(realtime.args[3], "--hold");

console.log("✓ call front-end selection tests passed");
