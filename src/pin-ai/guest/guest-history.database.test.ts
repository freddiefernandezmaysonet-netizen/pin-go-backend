import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { GuestPinAIGateway } from "./guest-runtime-gateway.js";
import { readGuestHistory } from "./guest-history-reader.js";
import { openGuestHistory, saveGuestActionReceipt } from "./guest-history.js";
import { createConversationMemory } from "../runtime/conversation-memory.js";

// This migration test mutates an isolated disposable schema, never Railway.
const url = new URL(process.env.DATABASE_URL ?? "http://missing");
const enabled = process.env.PIN_AI_HISTORY_DB_TEST === "true";
if (enabled && (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/pin_ai_history_test")) {
  throw new Error("Only the explicitly enabled local pin_ai_history_test database is allowed");
}

test("additive history migration preserves sessions; actual PostgreSQL stores and restores bounded dialogue and concurrent receipts", { skip: !enabled }, async () => {
  const prisma = new PrismaClient();
  const now = new Date("2026-09-27T03:30:00Z");
  const token = "synthetic-history-token-1234567890";
  const organization = await prisma.organization.create({ data: { name: "History test" } });
  const property = await prisma.property.create({ data: { organizationId: organization.id, name: "History test", timezone: "America/Puerto_Rico" } });
  const reservation = await prisma.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic Guest", guestToken: token,
    guestTokenExpiresAt: new Date("2026-10-01T00:00:00Z"), checkIn: new Date("2026-09-26T19:00:00Z"), checkOut: new Date("2026-09-28T15:00:00Z") } });
  try {
    await prisma.pinAIGuestConversation.create({ data: { reservationId: reservation.id, openaiSessionId: "synthetic-provider-session" } });
    await prisma.$executeRawUnsafe('ALTER TABLE "PinAIGuestConversation" DROP COLUMN "guestHistoryCiphertext", DROP COLUMN "guestActionReceiptsCiphertext"');
    const migration = readFileSync(new URL("../../../prisma/migrations/20260927032500_pin_ai_guest_history_v1/migration.sql", import.meta.url), "utf8");
    await prisma.$executeRawUnsafe(migration);
    const old = await prisma.pinAIGuestConversation.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(old.openaiSessionId, "synthetic-provider-session");
    assert.equal(old.guestHistoryCiphertext, null);
    const gateway = new GuestPinAIGateway(prisma, async (request, _location, session) => {
      assert.equal(session, "synthetic-provider-session");
      return { mode: "SHADOW", request, memory: createConversationMemory(request), actionsExecuted: false,
        response: { responseText: `Respuesta: ${request.conversation[0]?.content}`, openaiSessionId: session,
          toolCalls: [], escalationCreated: false, requiresHumanReview: false } };
    }, true, () => now);
    for (let i = 0; i < 22; i++) await gateway.reply({ guestToken: token, message: `Mensaje ${i}` });
    const scope = { guestToken: token, reservationId: reservation.id, propertyId: property.id, organizationId: organization.id };
    const history = await readGuestHistory(prisma, scope, now);
    assert.equal(history.length, 40);
    assert.equal(history[0].text, "Mensaje 2");
    assert.equal(history.at(-1)?.text, "Respuesta: Mensaje 21");
    const persisted = await prisma.pinAIGuestConversation.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.doesNotMatch(persisted.guestHistoryCiphertext!, /Mensaje|Respuesta/);
    assert.equal(persisted.leaseToken, null);
    await Promise.all(["proposal-one", "proposal-two"].map(proposalId => saveGuestActionReceipt(prisma, scope, { proposalId, checkoutUrl: "https://checkout.example.test/synthetic" } as never)));
    const receipts = await prisma.pinAIGuestConversation.findUniqueOrThrow({ where: { reservationId: reservation.id } });
    assert.equal(openGuestHistory<unknown[]>(scope, "receipts", receipts.guestActionReceiptsCiphertext!).length, 2);
    assert.equal(receipts.guestHistoryCiphertext, persisted.guestHistoryCiphertext);
  } finally {
    await prisma.reservation.delete({ where: { id: reservation.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.organization.delete({ where: { id: organization.id } });
    await prisma.$disconnect();
  }
});
