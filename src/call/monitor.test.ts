import assert from "node:assert/strict";

import { classifyCallLine } from "./monitor";

/**
 * The classifier is tested against VERBATIM lines from live log-stream captures
 * (~/scratch/ftlane/*.logstream) — the exact machine truth the lane
 * runs on — plus the noise shapes that must NOT classify. If Apple reshuffles these
 * strings in an OS update, the lane goes deaf; this test only guards OUR parsing.
 */
async function main(): Promise<void> {
  // ring — fires seconds before the banner (the prewarm trigger)
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:08.426 Df callservicesd[838:1177a4e] [com.apple.calls.callservicesd:Default] Received add incoming call request from call source <private> with UUID <private> update <private>",
    ),
    "ring",
  );
  assert.equal(
    classifyCallLine("… [com.apple.calls.callservicesd:Default] Handling incoming call: <private>"),
    "ring",
  );

  // answered — the AX press landing (callee-side only)
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:11.058 Df callservicesd[838:1177a53] [com.apple.calls.callservicesd:Default] Performing answer request <private> for call <private>",
    ),
    "answered",
  );

  // media — the ONLY trustworthy outbound-pickup signal (the CallHistory db lies)
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:11.189 Df avconferenced[1010:1177c04] [com.apple.AVConference:ViceroyTrace]  [NOTICE] -[VCTransportSessionIDSMultiLink handleLinkConnectedWithInfo:]:114 HandoverReport: new link established with link context <LinkContext 0xb7b640540> linkID 1",
    ),
    "media",
  );
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:11.086 Df avconferenced[1010:1177a67] [com.apple.AVConference:ViceroyTrace]  [NOTICE] -[VCConnectionHealthMonitor init]:68 HandoverReport: Primary connection health allowed delay = 0.10",
    ),
    "media",
  );
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:11.089 Df callservicesd[838:1177a82] [com.apple.AVConference:ViceroyTrace]  [NOTICE] -[AVCSession participant:audioEnabled:didSucceed:error:]:1031 (0x900645cc0) AVCSession[625CC3BB-EE1F-4679-AD83-363EC9FCA669] received callback for audio enabled[1] did succeed[1]",
    ),
    "media",
  );

  // disconnected
  assert.equal(
    classifyCallLine(
      "2026-07-30 12:57:20.116 Df callservicesd[838:1177bfe] [com.apple.calls.callservicesd:Default] Setting disconnected reason to remote hangup because ended reason is 2",
    ),
    "disconnected",
  );
  assert.equal(
    classifyCallLine("… [com.apple.calls.callservicesd:Default] Updating client <private> with disconnected call: <private> calls: <private>"),
    "disconnected",
  );
  assert.equal(
    classifyCallLine("… [com.apple.calls.callservicesd:Default] endCallWithUUIDAsLocalHangup: <private>"),
    "disconnected",
  );

  // lines that must NOT classify: an answer-during-teardown edge line, audio-device
  // chatter, and generic daemon noise are all null — no false triggers either way
  assert.equal(
    classifyCallLine(
      "… [com.apple.calls.callservicesd:Default] Asked to answer call <private> while disconnecting calls <private> and holding calls <private>",
    ),
    null,
  );
  assert.equal(classifyCallLine("… [com.apple.coreaudio:AUHAL] AUHAL.cpp:687 SelectDevice: disconnecting device 459"), null);
  assert.equal(
    classifyCallLine("… [com.apple.Translation:AssetObservation] Replaying last language status observations"),
    null,
  );

  console.log("✓ call monitor classifier tests passed");
}

void main();
