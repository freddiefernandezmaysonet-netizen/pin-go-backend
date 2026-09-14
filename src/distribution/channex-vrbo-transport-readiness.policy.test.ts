import assert from "node:assert/strict";
import test from "node:test";

import { deriveChannexVrboTransportReadiness } from "./channex-vrbo-transport-readiness.policy.js";

const commercial = {
  paymentReadiness: "NOT_STARTED" as const,
  taxReadiness: "NOT_STARTED" as const,
  contentReadiness: "NOT_STARTED" as const,
};
const mapping = { verified: true, reason: "VERIFIED" as const } as any;

test("Vrbo technical readiness requires exact VRB identity, mapping and active state", () => {
  const ready = deriveChannexVrboTransportReadiness({
    provider: "VRBO",
    expectedExternalConnectionId: "channel-1",
    expectedExternalChannelCode: "VRB",
    observedChannel: { id: "channel-1", channelCode: "VRB", isActive: true },
    mapping,
    currentCommercialReadiness: commercial,
  });
  assert.equal(ready.applied, true);
  assert.equal(ready.reason, "POLICY_APPLIED");
  assert.deepEqual(ready.readiness, commercial);
  assert.equal(ready.metadata.otaAcceptanceVerified, false);
});

test("Vrbo policy fails closed without exact active evidence", () => {
  for (const observedChannel of [
    null,
    { id: "other", channelCode: "VRB", isActive: true },
    { id: "channel-1", channelCode: "BDC", isActive: true },
    { id: "channel-1", channelCode: "VRB", isActive: false },
  ]) {
    const result = deriveChannexVrboTransportReadiness({
      provider: "VRBO",
      expectedExternalConnectionId: "channel-1",
      expectedExternalChannelCode: "VRB",
      observedChannel,
      mapping,
      currentCommercialReadiness: commercial,
    });
    assert.equal(result.applied, false);
  }
});
