import assert from "node:assert/strict";

// placeCall reads its config from env at call time, so set it before importing.
process.env.VAPI_API_KEY = "test-key";
process.env.VAPI_PHONE_NUMBER_ID = "test-number";
process.env.VAPI_ASSISTANT_ID = "test-assistant";
process.env.OWNER_NAME = "Owner Name";

/** Capture the body placeCall would POST to Vapi, without any network. */
async function capture(fn: () => Promise<unknown>): Promise<any> {
  const realFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "call_1", status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return body;
}

async function main(): Promise<void> {
  const { placeCall } = await import("./client");

  // The whole point of the gate: the owner's name is a TEMPLATE VARIABLE rendered
  // server-side in the greeting, upstream of the objective. So an objective that says
  // "don't give my name" cannot suppress it — only not sending the name can. Default
  // must therefore be anonymous.
  const anon = await capture(() =>
    placeCall({ to: "+13035551234", objective: "ask if they have a room tonight. do not give my name." }),
  );
  assert.equal(anon.assistantOverrides.variableValues.callerName, "the caller");

  // Explicitly opting out is still anonymous.
  const off = await capture(() =>
    placeCall({ to: "+13035551234", objective: "ask their hours", shareName: false }),
  );
  assert.equal(off.assistantOverrides.variableValues.callerName, "the caller");

  // Only an explicit opt-in shares identity — a reservation, an account lookup.
  const on = await capture(() =>
    placeCall({ to: "+13035551234", objective: "check the reservation under his name", shareName: true }),
  );
  assert.equal(on.assistantOverrides.variableValues.callerName, "Owner Name");

  // Opting in with no OWNER_NAME configured must degrade to anonymous, never to
  // an empty string the greeting would speak as a blank.
  const saved = process.env.OWNER_NAME;
  delete process.env.OWNER_NAME;
  const unset = await capture(() =>
    placeCall({ to: "+13035551234", objective: "check the reservation", shareName: true }),
  );
  assert.equal(unset.assistantOverrides.variableValues.callerName, "the caller");
  process.env.OWNER_NAME = saved;

  // The disclose flag is about AI-disclosure, not identity — it must not leak a name.
  const disclosed = await capture(() =>
    placeCall({ to: "+13035551234", objective: "ask their hours", disclose: true }),
  );
  assert.equal(disclosed.assistantOverrides.variableValues.callerName, "the caller");
  assert.equal(disclosed.assistantOverrides.variableValues.disclose, true);

  // The GREETING is the real test. It is spoken verbatim, before the system prompt or
  // the objective is worth anything, so it is where a name leaks first and worst. Every
  // anonymous variant above must carry an opening line with no name in it.
  const name = process.env.OWNER_NAME!;
  for (const [label, body] of [
    ["default", anon],
    ["explicit off", off],
    ["owner unset", unset],
    ["disclose", disclosed],
  ] as const) {
    const vars = body.assistantOverrides.variableValues;
    assert.ok(vars.greeting, `${label}: greeting must be sent, not left to a server-side literal`);
    assert.ok(vars.voicemailLine, `${label}: voicemail line must be sent too`);
    assert.ok(!vars.greeting.includes(name), `${label}: greeting leaked the owner's name`);
    assert.ok(!vars.voicemailLine.includes(name), `${label}: voicemail line leaked the owner's name`);
  }

  // ...and opting in actually says it, in both places.
  assert.ok(on.assistantOverrides.variableValues.greeting.includes(name));
  assert.ok(on.assistantOverrides.variableValues.voicemailLine.includes(name));

  console.log("voice/client: all checks passed");
}

main();
