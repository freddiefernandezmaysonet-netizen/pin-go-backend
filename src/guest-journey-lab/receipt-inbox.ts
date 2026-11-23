import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { assertLabEnvironment } from "./isolation";
import { recordMessageDeliveryOutcome, type ProviderDeliveryOutcome } from "../services/guest-journey-communications-delivery-outcome.service";

type Scope = { organizationId: string; propertyId: string };
type Receipt = {
  id: string; provider: ProviderDeliveryOutcome["provider"]; provider_id: string;
  status: ProviderDeliveryOutcome["status"]; event_at: Date; delivered_at: Date | null;
};
const statuses = new Set(["ACCEPTED", "QUEUED", "SENDING", "SENT", "DELIVERY_DELAYED",
  "DELIVERED", "READ", "UNDELIVERED", "FAILED", "BOUNCED", "SUPPRESSED", "COMPLAINED", "CANCELED"]);
function assertScope(scope: Scope) {
  assertLabEnvironment(process.env);
  if (scope.organizationId !== "gj_lab_organization" || !scope.propertyId.startsWith("gj_lab_")) {
    throw Error("GJ_LAB_RECEIPT_SCOPE_REJECTED");
  }
}

// Lab-only storage; no production migration or unauthenticated webhook route.
// Persist normalized synthetic evidence, never recipient details or raw payloads.
export async function prepareReceiptInbox(db: PrismaClient) {
  assertLabEnvironment(process.env);
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS guest_journey_lab.receipt_inbox (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, property_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('twilio', 'resend')), provider_id TEXT NOT NULL,
    status TEXT NOT NULL, event_at TIMESTAMPTZ NOT NULL, delivered_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS receipt_inbox_pending
    ON guest_journey_lab.receipt_inbox(organization_id, property_id, last_attempt_at, received_at)
    WHERE processed_at IS NULL`);
}

export async function retainLabReceipt(db: PrismaClient, scope: Scope, outcome: ProviderDeliveryOutcome) {
  assertScope(scope);
  if (!["twilio", "resend"].includes(outcome.provider) || !outcome.providerMessageId.startsWith("LAB_") ||
      !statuses.has(outcome.status) || !Number.isFinite(outcome.eventAt.getTime()) ||
      (outcome.deliveredAt && (!Number.isFinite(outcome.deliveredAt.getTime()) || outcome.deliveredAt > outcome.eventAt))) {
    throw Error("GJ_LAB_RECEIPT_INVALID");
  }
  const id = createHash("sha256").update(JSON.stringify([
    scope.organizationId, scope.propertyId, outcome.provider, outcome.providerMessageId,
    outcome.status, outcome.eventAt.toISOString(), outcome.deliveredAt?.toISOString() ?? null,
  ])).digest("hex");
  await db.$executeRaw`INSERT INTO guest_journey_lab.receipt_inbox
    (id, organization_id, property_id, provider, provider_id, status, event_at, delivered_at)
    VALUES (${id}, ${scope.organizationId}, ${scope.propertyId}, ${outcome.provider},
      ${outcome.providerMessageId}, ${outcome.status}, ${outcome.eventAt}, ${outcome.deliveredAt ?? null})
    ON CONFLICT (id) DO NOTHING`;
  return id;
}

export async function replayLabReceipts(db: PrismaClient, scope: Scope) {
  assertScope(scope);
  return db.$transaction(async tx => {
    const receipts = await tx.$queryRaw<Receipt[]>`SELECT id, provider, provider_id, status, event_at, delivered_at
      FROM guest_journey_lab.receipt_inbox
      WHERE organization_id=${scope.organizationId} AND property_id=${scope.propertyId} AND processed_at IS NULL
      ORDER BY last_attempt_at NULLS FIRST, received_at, id LIMIT 50 FOR UPDATE SKIP LOCKED`;
    let processed = 0;
    for (const receipt of receipts) {
      await tx.$executeRaw`UPDATE guest_journey_lab.receipt_inbox
        SET attempts=attempts+1, last_attempt_at=NOW() WHERE id=${receipt.id}`;
      const matches = await tx.messageLog.findMany({ where: {
        provider: receipt.provider, providerMessageId: receipt.provider_id,
      }, take: 2, select: { id: true, organizationId: true, propertyId: true } });
      if (matches.length !== 1 || matches[0].organizationId !== scope.organizationId ||
          matches[0].propertyId !== scope.propertyId) continue;
      const result = await recordMessageDeliveryOutcome(tx as unknown as PrismaClient, {
        provider: receipt.provider, providerMessageId: receipt.provider_id,
        status: receipt.status, eventAt: receipt.event_at, deliveredAt: receipt.delivered_at,
      });
      if (!result.matched) continue;
      // Evidence application and processing acknowledgement commit together.
      // An obsolete duplicate is also consumed; an unknown correlation stays pending.
      await tx.$executeRaw`UPDATE guest_journey_lab.receipt_inbox SET processed_at=NOW() WHERE id=${receipt.id}`;
      processed++;
    }
    return { examined: receipts.length, processed, providerCalls: 0 as const };
  });
}

export async function readLabReceiptInbox(db: PrismaClient, scope: Scope) {
  assertScope(scope);
  const rows = await db.$queryRaw<Array<{ retained: number; pending: number; processed: number }>>`
    SELECT COUNT(*)::int AS retained,
      COUNT(*) FILTER (WHERE processed_at IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
    FROM guest_journey_lab.receipt_inbox
    WHERE organization_id=${scope.organizationId} AND property_id=${scope.propertyId}`;
  return { ...rows[0], simulationOnly: true, productionReady: false };
}
