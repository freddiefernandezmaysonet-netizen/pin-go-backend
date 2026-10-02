import { createHash } from "node:crypto";
import type { MessageLog, PrismaClient } from "@prisma/client";
import { getEmailSender } from "../lib/email-senders.js";
import { sendCleaningHostAttentionEmail, sendDirectBookingGuestCancellationEmail,
  sendDirectBookingHostCancellationNotification } from "../lib/mailer.js";
import { resolveCleaningHostAttentionRecipients } from "./cleaning-followup-host-recipient.service.js";

// Isolated ownership: legacy/E7 retries must never claim this outbox's rows.
export const DURABLE_EMAIL_TYPES = ["CLEANING_HOST_ATTENTION_DURABLE_V1",
  "DIRECT_BOOKING_GUEST_CANCELLATION_DURABLE_V1", "DIRECT_BOOKING_HOST_CANCELLATION_DURABLE_V1"] as const;
type Kind = "cleaning" | "guestCancellation" | "hostCancellation";
type MailByKind = {
  cleaning: Parameters<typeof sendCleaningHostAttentionEmail>[0];
  guestCancellation: Parameters<typeof sendDirectBookingGuestCancellationEmail>[0];
  hostCancellation: Parameters<typeof sendDirectBookingHostCancellationNotification>[0];
};
type Scope = { organizationId: string; propertyId: string; reservationId: string };
type Envelope = {
  kind: "PIN_GO_DURABLE_EMAIL_V1"; purpose: Kind; mail: Record<string, any>;
  cleaningWorkId?: string; cancelledAt?: string; idempotencyKey: string;
  expiresAt: string; nextAttemptAt: string;
};
const TYPES: Record<Kind, string> = { cleaning: DURABLE_EMAIL_TYPES[0],
  guestCancellation: DURABLE_EMAIL_TYPES[1], hostCancellation: DURABLE_EMAIL_TYPES[2] };
const ACTIVE = ["OUTBOX_PENDING", "OUTBOX_RETRY", "OUTBOX_SENDING"];
const MAX_ATTEMPTS = 4;
const LEASE_MS = 90_000;
export const EMAIL_REPLAY_WINDOW_MS = 23 * 60 * 60_000;
const normalized = (value: unknown) => String(value ?? "").trim().toLowerCase();
const sender = (kind: Kind) => getEmailSender(kind === "cleaning" ? "cleaning" : "reservations");
const iso = (value: unknown) => {
  const d = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
};

export async function enqueueOperationalEmail<K extends Kind>(prisma: PrismaClient, input: Scope & {
  purpose: K; eventKey: string; mail: MailByKind[K]; cleaningWorkId?: string;
  cancelledAt?: string; eventAt: Date; idempotencyKey?: string;
}) {
  if (!input.organizationId || !input.propertyId || !input.reservationId || !input.eventKey ||
    !Number.isFinite(input.eventAt.getTime())) throw new Error("OUTBOX_SCOPE_INVALID");
  const to = Array.isArray(input.mail.to) ? [...input.mail.to].map(normalized).sort().join(",") : normalized(input.mail.to);
  if (!to) throw new Error("OUTBOX_RECIPIENT_MISSING");
  const id = `operational-email-${createHash("sha256").update(JSON.stringify([
    input.organizationId, input.propertyId, input.reservationId, input.purpose, input.eventKey,
    input.purpose === "cleaning" ? "" : to,
  ])).digest("hex")}`;
  const mail = JSON.parse(JSON.stringify(input.mail));
  mail.to = Array.isArray(input.mail.to) ? to.split(",") : to;
  const envelope: Envelope = {
    kind: "PIN_GO_DURABLE_EMAIL_V1", purpose: input.purpose, mail,
    ...(input.cleaningWorkId ? { cleaningWorkId: input.cleaningWorkId } : {}),
    ...(input.cancelledAt ? { cancelledAt: input.cancelledAt } : {}),
    idempotencyKey: input.idempotencyKey ?? id,
    expiresAt: new Date(input.eventAt.getTime() + EMAIL_REPLAY_WINDOW_MS).toISOString(),
    nextAttemptAt: input.eventAt.toISOString(),
  };
  try {
    return await prisma.messageLog.create({ data: {
      id, channel: "email", provider: "resend", communicationType: TYPES[input.purpose],
      to, from: sender(input.purpose), body: JSON.stringify(envelope), status: "OUTBOX_PENDING",
      organizationId: input.organizationId, propertyId: input.propertyId, reservationId: input.reservationId,
    } });
  } catch (error: any) {
    if (error?.code !== "P2002") throw error;
    // Never replace the immutable payload/key of an existing event.
    return prisma.messageLog.findUniqueOrThrow({ where: { id } });
  }
}

function parse(message: MessageLog): Envelope {
  const e = JSON.parse(message.body) as Envelope;
  const mailTo = Array.isArray(e.mail?.to) ? e.mail.to.map(normalized).sort().join(",") : normalized(e.mail?.to);
  if (e.kind !== "PIN_GO_DURABLE_EMAIL_V1" || !Object.hasOwn(TYPES, e.purpose) ||
    message.communicationType !== TYPES[e.purpose] || message.from !== sender(e.purpose) ||
    !e.idempotencyKey || !iso(e.expiresAt) || !iso(e.nextAttemptAt) || !mailTo || mailTo !== message.to ||
    !message.organizationId || !message.propertyId || !message.reservationId ||
    (e.purpose === "cleaning" ? !e.cleaningWorkId : !iso(e.cancelledAt))) {
    throw new Error("OUTBOX_PAYLOAD_INVALID");
  }
  return e;
}

async function eligible(prisma: PrismaClient, m: MessageLog, e: Envelope) {
  const r = await prisma.reservation.findFirst({ where: {
    id: m.reservationId!, propertyId: m.propertyId!, property: { organizationId: m.organizationId! },
  }, select: { id: true, status: true, cancelledAt: true, guestEmail: true, checkIn: true, checkOut: true,
    source: true, externalProvider: true, stripeCheckoutSessionId: true } });
  if (!r) return false;
  if (e.purpose === "cleaning") {
    const work = await prisma.cleaningWork.findFirst({ where: { id: e.cleaningWorkId,
      reservationId: m.reservationId!, propertyId: m.propertyId!, cancelledAt: null,
      supersededAt: null, completionConfirmedAt: null } });
    const notice = await prisma.cleaningHostAttentionNotice.findUnique({ where: { cleaningWorkId: e.cleaningWorkId! } });
    if (!work || !notice || !["QUEUED", "FAILED"].includes(notice.status) || r.status === "CANCELLED") return false;
    const recipients = await resolveCleaningHostAttentionRecipients(prisma, m.organizationId!);
    return Array.isArray(e.mail.to) && e.mail.to.every((to: string) => recipients.map(normalized).includes(normalized(to)));
  }
  if (r.status !== "CANCELLED" || iso(r.cancelledAt) !== e.cancelledAt ||
    iso(r.checkIn) !== iso(e.mail.checkIn) || iso(r.checkOut) !== iso(e.mail.checkOut) ||
    !(r.source === "DIRECT_BOOKING" || r.externalProvider === "PIN_GO_DIRECT" || r.stripeCheckoutSessionId)) return false;
  if (e.purpose === "guestCancellation") return normalized(r.guestEmail) === m.to;
  const users = await prisma.dashboardUser.findMany({ where: { organizationId: m.organizationId!, isActive: true },
    select: { email: true, role: true } });
  const admins = users.filter(u => u.role === "ORG_ADMIN");
  return (admins.length ? admins : users).some(u => normalized(u.email) === m.to);
}

async function projectCleaning(prisma: PrismaClient, m: MessageLog, e: Envelope) {
  if (e.purpose !== "cleaning") return;
  await prisma.cleaningHostAttentionNotice.updateMany({
    where: { cleaningWorkId: e.cleaningWorkId, status: { in: ["QUEUED", "FAILED"] } },
    data: { status: "SENT", recipientsJson: e.mail.to, providerMessageId: m.providerMessageId,
      sentAt: new Date(), lastError: null },
  });
}

async function providerSend(e: Envelope) {
  const mail: Record<string, any> = { ...e.mail, idempotencyKey: e.idempotencyKey };
  for (const key of ["checkIn", "checkOut", "cancelledAt"]) {
    if (mail[key]) mail[key] = new Date(mail[key]);
  }
  const result = e.purpose === "cleaning"
    ? await sendCleaningHostAttentionEmail(mail as MailByKind["cleaning"])
    : e.purpose === "guestCancellation"
      ? await sendDirectBookingGuestCancellationEmail(mail as MailByKind["guestCancellation"])
      : await sendDirectBookingHostCancellationNotification(mail as MailByKind["hostCancellation"]);
  const id = (result as any)?.providerMessageId ?? (result as any)?.data?.id;
  if (!id) throw new Error("OUTBOX_PROVIDER_ACK_MISSING");
  return String(id);
}

export async function deliverOperationalEmail(prisma: PrismaClient, m: MessageLog,
  options: { now?: Date; send?: (envelope: Envelope) => Promise<string> } = {}) {
  const now = options.now ?? new Date();
  const expected = { id: m.id, body: m.body, status: m.status, retryCount: m.retryCount };
  const stop = async (status: string, reason: string) => {
    await prisma.messageLog.updateMany({ where: expected, data: { status, error: reason } });
    return status;
  };
  let e: Envelope;
  try { e = parse(m); } catch { return stop("FAILED_FINAL", "OUTBOX_PAYLOAD_INVALID"); }
  if (m.status === "SENT") { await projectCleaning(prisma, m, e); return "SENT"; }
  if (!ACTIVE.includes(m.status ?? "")) return m.status ?? "UNCHANGED";
  if (Date.parse(e.nextAttemptAt) > now.getTime()) return "NOT_DUE";
  if (m.retryCount >= MAX_ATTEMPTS || now.getTime() >= Date.parse(e.expiresAt)) {
    return stop("FAILED_FINAL", "OUTBOX_RETRY_BUDGET_EXHAUSTED");
  }
  if (!(await eligible(prisma, m, e))) return stop("OBSOLETE", "OUTBOX_SCOPE_OR_RECIPIENT_CHANGED");
  const claimed = JSON.stringify({ ...e, nextAttemptAt: new Date(now.getTime() + LEASE_MS).toISOString() });
  const claim = await prisma.messageLog.updateMany({ where: expected,
    data: { status: "OUTBOX_SENDING", body: claimed, retryCount: { increment: 1 } } });
  if (!claim.count) return "CLAIM_LOST";
  const claimedWhere = { id: m.id, body: claimed, status: "OUTBOX_SENDING", retryCount: m.retryCount + 1 };
  // Recheck after acquiring the lease, immediately before the provider call.
  if (!(await eligible(prisma, m, e))) {
    await prisma.messageLog.updateMany({ where: claimedWhere,
      data: { status: "OBSOLETE", error: "OUTBOX_SCOPE_OR_RECIPIENT_CHANGED" } });
    return "OBSOLETE";
  }
  let providerMessageId: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    providerMessageId = await Promise.race([
      (options.send ?? providerSend)(e),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OUTBOX_TIMEOUT")), 20_000); }),
    ]);
    if (!providerMessageId) throw new Error("OUTBOX_PROVIDER_ACK_MISSING");
  } catch (error: any) {
    const code = Number(error?.statusCode);
    const transient = code === 408 || code === 429 ||
      (code === 409 && error?.providerCode === "concurrent_idempotent_requests");
    const final = m.retryCount + 1 >= MAX_ATTEMPTS || (code >= 400 && code < 500 && !transient);
    await prisma.messageLog.updateMany({ where: claimedWhere, data: {
      status: final ? "FAILED_FINAL" : "OUTBOX_RETRY", error: final ? "OUTBOX_SEND_FAILED_FINAL" : "OUTBOX_RETRY_PENDING",
      body: JSON.stringify({ ...e, nextAttemptAt: new Date(now.getTime() + [60_000, 300_000, 900_000][Math.min(m.retryCount, 2)]!).toISOString() }),
    } });
    return final ? "FAILED_FINAL" : "OUTBOX_RETRY";
  } finally { if (timer) clearTimeout(timer); }
  // A persistence failure leaves SENDING: replay the same payload/key after lease expiry.
  const saved = await prisma.messageLog.updateMany({ where: claimedWhere,
    data: { status: "SENT", providerMessageId, error: null } });
  if (saved.count) await projectCleaning(prisma, { ...m, providerMessageId }, e);
  return saved.count ? "SENT" : "CLAIM_LOST";
}

let cursor: string | undefined;
export async function processOperationalEmailOutbox(prisma: PrismaClient, batchSize = 20) {
  const rows = await prisma.messageLog.findMany({ where: { channel: "email", provider: "resend",
    communicationType: { in: [...DURABLE_EMAIL_TYPES] }, status: { in: ACTIVE },
    ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: batchSize });
  cursor = rows.length === batchSize ? rows.at(-1)!.id : undefined;
  for (const m of rows) {
    try { await deliverOperationalEmail(prisma, m); }
    catch { console.error("[OPERATIONAL_EMAIL] durable notice retained", { messageId: m.id }); }
  }
}
