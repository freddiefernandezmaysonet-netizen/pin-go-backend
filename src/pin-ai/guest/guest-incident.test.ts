import assert from "node:assert/strict";
import test from "node:test";
import type { MessageLog, PrismaClient } from "@prisma/client";
import { guestIncidentEnabled, incidentNotificationState, parseIncidentInput, formatGuestIncidentReceipt } from "./guest-incident-policy.js";
import { deliverGuestIncidentNotice } from "./guest-incident-notification.service.js";
import { buildGuestIncidentEmail } from "../../lib/email-templates/guestIncidentEmail.js";
import { assertRuntimeResponseSafe } from "../runtime/policy.js";

const now = new Date("2026-09-27T15:00:00Z");
const env = { PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: "reservation-51",
  PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "true" };
function fixture() {
  let row = { id: "message-1", body: JSON.stringify({ kind: "PIN_GO_EMAIL_DELIVERY", type: "PIN_AI_GUEST_INCIDENT_HOST_NOTICE",
    retryPayload: { issueId: "issue-1", reference: "GI-012345ABCDEF", category: "HOT_WATER", reservationNumber: "PG-2026-000051",
      propertyName: "Demo", quotes: ["Sale fría en todos los grifos"], dashboardOrigin: "https://app.example.test" },
    nextAttemptAt: now.toISOString(), firstAttemptAt: null }), to: "host@example.test", channel: "email", provider: "resend",
    status: "QUEUED", retryCount: 0, providerMessageId: null, providerDeliveryStatus: null,
    reservationId: "reservation-51", propertyId: "property-1", organizationId: "org-1" } as MessageLog;
  let eligible = true, active = true, persistenceFailure = false, attention = 0;
  const prisma = {
    messageLog: { async updateMany({ where, data }: any) {
      if (data.status === "SENT" && persistenceFailure) throw new Error("DB_UNAVAILABLE_AFTER_PROVIDER_ACK");
      if (!Object.entries(where).every(([key, value]) => (row as any)[key] === value)) return { count: 0 };
      row = { ...row, ...data, retryCount: data.retryCount?.increment ? row.retryCount + data.retryCount.increment : row.retryCount };
      return { count: 1 };
    } },
    operationalIssue: { async findFirst({ where }: any) {
      assert.equal(where.organizationId, "org-1"); assert.equal(where.reservationId, "reservation-51");
      return eligible ? { id: "issue-1", workflowState: "ACTION_REQUIRED" } : null;
    }, async updateMany() { attention++; return { count: 1 }; } },
    reservation: { async findFirst({ where }: any) { assert.equal(where.property.organizationId, "org-1"); return eligible ? { id: "reservation-51" } : null; } },
    dashboardUser: { async findMany({ where }: any) {
      assert.deepEqual(where, { organizationId: "org-1", role: { in: ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"] }, isActive: true });
      return active ? [{ email: "HOST@example.test" }] : [];
    } },
  } as unknown as PrismaClient;
  return { prisma, get row() { return structuredClone(row); }, patch(data: Partial<MessageLog>) { row = { ...row, ...data }; },
    revoke() { active = false; }, invalidateScope() { eligible = false; }, failPersistence(value: boolean) { persistenceFailure = value; }, get attention() { return attention; } };
}

test("incident canary fails closed independently from action canary", () => {
  for (const e of [{}, { ...env, PIN_AI_INCIDENT_ENABLED: "false" }, { ...env, PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: "" },
    { ...env, PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: "*" }]) assert.equal(guestIncidentEnabled("reservation-51", e), false);
  assert.equal(guestIncidentEnabled("reservation-51", env), true);
  assert.equal(guestIncidentEnabled("reservation-11", env), false);
});
test("tool rejects arbitrary recipients, scope, oversized quotes and unsupported categories", () => {
  const valid = { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["Sale fría"] };
  for (const data of [{ ...valid, to: "attacker@example.test" }, { ...valid, organizationId: "other" },
    { ...valid, category: "REFUND" }, { ...valid, guestQuotes: [] }, { ...valid, guestQuotes: ["x".repeat(501)] },
    { ...valid, operation: "STATUS" }]) assert.throws(() => parseIncidentInput(data));
  assert.equal(parseIncidentInput(valid).category, "HOT_WATER");
});
test("receipt never equates sent with delivered, read, or resolved", () => {
  assert.equal(incidentNotificationState([]), "ATTENTION_REQUIRED");
  assert.equal(incidentNotificationState([{ status: "SENT", providerDeliveryStatus: null }]), "ACCEPTED");
  assert.equal(incidentNotificationState([{ status: "FAILED", providerDeliveryStatus: null }]), "QUEUED");
  assert.equal(incidentNotificationState([{ status: "SENT", providerDeliveryStatus: "DELIVERED" }, { status: "FAILED_FINAL", providerDeliveryStatus: null }]), "ATTENTION_REQUIRED");
  const receipt = { reference: "GI-012345ABCDEF", category: "HOT_WATER" as const, incidentRecorded: true as const,
    notification: "DELIVERED" as const, resolution: "OPEN" as const, hostAcknowledged: false as const };
  assert.match(formatGuestIncidentReceipt(receipt, "es"), /no confirma.*leído/);
  assert.match(formatGuestIncidentReceipt(receipt, "en"), /resolution pending/);
});
test("recorded escalation cannot bypass payment/refund/reservation claim protections", () => {
  for (const responseText of ["Your reservation has been changed", "I have issued a refund", "Tu pago fue procesado", "He notificado al anfitrión"]) {
    assert.throws(() => assertRuntimeResponseSafe({ responseText, escalationCreated: true, toolCalls: [], requiresHumanReview: false }), /FALSE_COMPLETION/);
  }
});
test("acknowledgement is distinct from email delivery and physical resolution in both languages", () => {
  for (const resolution of ["OPEN", "RESOLVED"] as const) {
    const receipt = { reference: "GI-012345ABCDEF", category: "HOT_WATER" as const, incidentRecorded: true as const,
      notification: "DELIVERED" as const, resolution, hostAcknowledged: true };
    const es = formatGuestIncidentReceipt(receipt, "es"), en = formatGuestIncidentReceipt(receipt, "en");
    assert.match(es, /correo inicial/); assert.match(es, /confirmó la atención/);
    assert.match(es, /no acredita una reparación física/); assert.doesNotMatch(es, /haya leído/);
    assert.match(en, /initial email/); assert.match(en, /host acknowledged/);
    assert.match(en, /does not verify a physical repair/);
    assert.match(es, resolution === "OPEN" ? /pendiente de resolución/ : /figura resuelto/);
  }
});
test("notice template escapes guest content and links to authenticated Dashboard without approval credentials", () => {
  const built = buildGuestIncidentEmail({ to: "host@example.test", reference: "GI-012345ABCDEF", category: "HOT_WATER",
    reservationNumber: "PG-2026-000051", propertyName: "Demo", quotes: ['<script>bad()</script> & "x"'],
    dashboardUrl: "https://app.example.test/reservations/res-1", idempotencyKey: "key" });
  assert.doesNotMatch(built.html, /<script>/); assert.match(built.html, /&lt;script&gt;/);
  assert.match(built.text, /not a verified diagnosis/); assert.match(built.html, /Sign-in required/);
});
test("parallel workers claim once and record provider acceptance, not delivery", async () => {
  const f = fixture(); let sends = 0;
  const send = async () => { sends++; return "provider-ack"; };
  const results = await Promise.all([1, 2].map(() => deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send })));
  assert.equal(sends, 1); assert.ok(results.includes("CLAIM_LOST")); assert.equal(f.row.status, "SENT");
  assert.equal(f.row.providerMessageId, "provider-ack"); assert.equal(f.row.providerDeliveryStatus, null);
});
test("notification disabled, missing scope or revoked admin never send", async () => {
  for (const scenario of ["disabled", "scope", "admin"]) {
    const f = fixture(); if (scenario === "scope") f.invalidateScope(); if (scenario === "admin") f.revoke();
    await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env: scenario === "disabled" ? { ...env, PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "false" } : env,
      now, send: async () => { assert.fail("must not send"); } });
    assert.equal(f.row.status, scenario === "disabled" ? "QUEUED" : "FAILED_FINAL");
  }
});
test("transport failure backs off, reuses provider key, and stops after four attempts", async () => {
  const f = fixture(); const keys: string[] = [];
  const send = async (mail: { idempotencyKey: string }) => { keys.push(mail.idempotencyKey); throw new Error("NETWORK_TIMEOUT"); };
  await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send });
  assert.equal(f.row.status, "FAILED");
  assert.equal(await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send }), "NOT_DUE");
  for (const minute of [1, 6, 21]) await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now: new Date(now.getTime() + minute * 60_000), send });
  assert.equal(keys.length, 4); assert.equal(new Set(keys).size, 1); assert.equal(f.row.status, "FAILED_FINAL"); assert.equal(f.attention, 1);
});
test("crash after provider acceptance replays the same immutable payload and key after lease expiry", async () => {
  const f = fixture(); f.failPersistence(true); const mails: unknown[] = [];
  const send = async (mail: unknown) => { mails.push(mail); return "same-provider-id"; };
  await assert.rejects(deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send }), /DB_UNAVAILABLE/);
  assert.equal(f.row.status, "SENDING"); f.failPersistence(false);
  assert.equal(await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send }), "NOT_DUE");
  await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now: new Date(now.getTime() + 91_000), send });
  assert.deepEqual(mails[0], mails[1]); assert.equal(f.row.providerMessageId, "same-provider-id");
});
test("uncertain delivery is never replayed after idempotency safety window", async () => {
  const f = fixture(); const envelope = JSON.parse(f.row.body); envelope.firstAttemptAt = new Date(now.getTime() - 24 * 3600_000).toISOString();
  f.patch({ body: JSON.stringify(envelope), status: "SENDING", retryCount: 1 });
  await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send: async () => assert.fail("must not replay") });
  assert.equal(f.row.status, "FAILED_FINAL");
});
test("provider bounce or terminal failure requires attention and never resolves incident", async () => {
  for (const providerDeliveryStatus of ["FAILED", "BOUNCED", "SUPPRESSED", "COMPLAINED"]) {
    const f = fixture(); f.patch({ status: "SENT", providerDeliveryStatus });
    await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send: async () => assert.fail("must not resend") });
    assert.equal(f.row.status, "FAILED_FINAL"); assert.equal(f.attention, 1);
  }
});

test("missing delivery evidence ages into attention without an uncertain resend; late delivery stays visible", async () => {
  const f = fixture(); const envelope = JSON.parse(f.row.body);
  envelope.firstAttemptAt = new Date(now.getTime() - 61 * 60_000).toISOString();
  f.patch({ status: "SENT", providerMessageId: "accepted-id", body: JSON.stringify(envelope) });
  await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now, send: async () => assert.fail("must not resend accepted notice") });
  assert.equal(f.row.error, "NOTICE_DELIVERY_UNCONFIRMED");
  assert.equal(incidentNotificationState([f.row]), "ATTENTION_REQUIRED");
  f.patch({ providerDeliveryStatus: "DELIVERED" });
  assert.equal(incidentNotificationState([f.row]), "DELIVERED");
});

test("permanent provider rejection stops immediately while rate limits remain retryable", async () => {
  for (const code of [400, 401, 422, 429, 503]) {
    const f = fixture();
    await deliverGuestIncidentNotice({ prisma: f.prisma, message: f.row, env, now,
      send: async () => { throw Object.assign(new Error("PROVIDER_REJECTED"), { statusCode: code }); } });
    assert.equal(f.row.status, [429, 503].includes(code) ? "FAILED" : "FAILED_FINAL");
  }
});
