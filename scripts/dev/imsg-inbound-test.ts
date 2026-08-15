/**
 * Throwaway: stand up ONLY the imsg transport's inbound path and print whatever it
 * ingests, without touching the live bot. Verifies watch → parse → InboundMessage
 * before we cut the whole bot over to TRANSPORT=imsg. Ctrl-C to stop.
 */
import "dotenv/config";
import { makeImsgTransport } from "../../src/transport/imsg";

const t = makeImsgTransport();
console.log("[imsg-test] listening — send fig an iMessage (text, image, tapback)…");

setInterval(async () => {
  const msgs = await t.poll();
  for (const m of msgs) {
    console.log(
      `[imsg-test] INBOUND from=${m.from} text=${JSON.stringify(m.text)} media=${m.mediaPaths?.length ?? 0} id=${m.id}`,
    );
  }
}, 800);
