import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { handleGuestIncident } from "../guest/guest-incident.service.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";

test("guest status reads acknowledgement from the same scoped incident without reading private messages", async () => {
  for (const acknowledgedAt of [null, new Date()]) {
    const context = { organizationId: "org", propertyId: "property", reservationId: "reservation",
      guestId: "guest", preferredLanguage: "es", currentLocalDateTime: new Date().toISOString() };
    const tx = {
      reservation: { findFirst: async () => ({ id: "reservation" }) },
      $executeRawUnsafe: async () => 1,
      operationalIssue: { findFirst: async () => ({ id: "issue", workflowState: "RESOLVED", metadata: { reference: "GI-012345ABCDEF" } }) },
      messageLog: { findMany: async () => [{ status: "SENT", providerDeliveryStatus: "DELIVERED" }] },
      pinAIHostIncidentThread: { findFirst: async (query: unknown) => {
        assert.deepEqual(query, { where: { issueId: "issue", organizationId: "org", propertyId: "property", reservationId: "reservation" }, select: { acknowledgedAt: true } });
        return acknowledgedAt ? { acknowledgedAt } : null;
      } },
    };
    const prisma = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
    const result = await handleGuestIncident({ prisma, guestToken: "synthetic-token", request: { context, conversation: [] } as PinAIRuntimeRequest,
      args: { operation: "STATUS", category: "HOT_WATER" },
      env: { PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: "reservation" } });
    assert.equal(result!.hostAcknowledged, acknowledgedAt !== null);
    assert.equal(result!.resolution, "RESOLVED");
    assert.equal(result!.notification, "DELIVERED");
  }
});
