import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ingestReservation } from "./ingest.service.js";
import { completeInternalDemoSecurePrecheckin } from "./internal-demo-secure-precheckin.service.js";
import { applyInternalDemoDirectBookingParity } from "./internal-demo-direct-booking-parity.service.js";
import { dispatchPendingCleaningConfirmationForReservation } from "./cleaning-confirmation-dispatch.service.js";
import { resolveInternalDemoPrimaryAdmin } from "./internal-demo-primary-admin.service.js";
import { readCleanerAccessWindow } from "./cleaner-access-window.service.js";
import { demoMessageState } from "./internal-demo-message.service.js";
import { INTERNAL_DEMO_PROPERTY_ID, INTERNAL_DEMO_SOURCE, INTERNAL_DEMO_PROVIDER, isInternalDemo } from "./internal-demo-scope.js";

export type DemoActor = { userId: string; organizationId: string; email: string | null; role: string };
export class DemoRunError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly safeToEdit = false) { super(code); }
}
function authorize(actor: DemoActor) {
  if (actor.role !== "PLATFORM_ADMIN" || !actor.userId || !actor.organizationId) throw new DemoRunError("FORBIDDEN", 403);
}
function requestId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new DemoRunError("DEMO_REQUEST_ID_REQUIRED", 400);
  return value;
}
const dependencies = { ingest: ingestReservation, secure: completeInternalDemoSecurePrecheckin,
  parity: applyInternalDemoDirectBookingParity, cleaning: dispatchPendingCleaningConfirmationForReservation };

export async function readDemoPreparation(db: PrismaClient, actor: DemoActor, env = process.env) {
  authorize(actor);
  const property = await db.property.findFirst({ where: { id: INTERNAL_DEMO_PROPERTY_ID,
    organizationId: actor.organizationId, status: "ACTIVE" }, include: { locks: { where: { isActive: true } } } });
  if (!property) throw new DemoRunError("DEMO_PROPERTY_UNAVAILABLE");
  const primaryAdmin = await resolveInternalDemoPrimaryAdmin(db, actor.organizationId, actor.userId);
  const staff = await db.propertyStaff.findMany({ where: { propertyId: property.id, isActive: true,
    staffMember: { isActive: true, phoneE164: { not: null } } }, include: { staffMember: true } });
  const cleaner = staff.find(s => s.role === "PRIMARY") ?? staff.filter(s => s.role === "BACKUP").sort((a,b) => (a.backupOrder ?? 0) - (b.backupOrder ?? 0))[0];
  const agreement = await db.propertyGuestAgreement.findFirst({ where: { propertyId: property.id, isActive: true } });
  const ttlockAuth = await db.tTLockAuth.findUnique({ where: { organizationId: actor.organizationId }, select: { id: true } });
  const cleanerCard = cleaner?.staffMember.ttlockCardRef ? await db.nfcCard.findFirst({ where: {
    propertyId: property.id, label: cleaner.staffMember.ttlockCardRef, status: { not: "RETIRED" },
    ttlockCardId: { gt: 0 } }, select: { id: true } }) : null;
  // The existing guest access worker schedules two distinct Guest cards.
  const guestCards = await db.nfcCard.findMany({ where: { propertyId: property.id, status: "AVAILABLE",
    label: { startsWith: "Guest-", mode: "insensitive" }, ttlockCardId: { gt: 0 } },
    distinct: ["ttlockCardId"], take: 2, select: { id: true } });
  // Notification delivery is owned by message-retry-worker and checks its own
  // PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED switch. It is not an API setting.
  const required = ["PIN_AI_GUEST_GATEWAY_ENABLED", "PIN_AI_RUNTIME_SHADOW_ENABLED", "PIN_AI_RUNTIME_REAL_READ_ENABLED",
    "PIN_AI_INCIDENT_ENABLED", "PIN_AI_HOST_INCIDENT_ENABLED"];
  const blockers = [
    ...(!primaryAdmin ? ["PRIMARY_ADMIN_MISSING"] : []),
    ...(!cleaner ? ["CLEANER_MISSING"] : []),
    ...(cleaner && !cleaner.cleaningDurationCommitmentMinutes ? ["CLEANER_COMPLETION_FLOW_NOT_CONFIGURED"] : []),
    ...(!cleanerCard ? ["CLEANER_CARD_MISSING"] : []),
    ...(guestCards.length < 2 ? ["GUEST_CARDS_UNAVAILABLE"] : []),
    ...(!ttlockAuth ? ["TTLOCK_CONNECTION_MISSING"] : []),
    ...(!property.cleaningNfcEnabled ? ["CLEANING_NFC_DISABLED"] : []),
    ...(!agreement ? ["AGREEMENT_MISSING"] : []),
    ...(property.locks.length !== 1 || property.locks[0]?.ttlockLockId !== 29944630 ? ["DEMO_LOCK_BINDING_REQUIRED"] : []),
    ...required.filter(k => env[k] !== "true").map(k => `${k}_DISABLED`),
    ...["OPENAI_API_KEY", "PIN_AI_OPENAI_AGENT_ID", "RESEND_API_KEY", "PIN_AI_HOST_INCIDENT_KEYS", "PIN_AI_HOST_INCIDENT_KEY_ID",
      "TWILIO_ACCOUNT_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET", "TWILIO_FROM_NUMBER", "TTLOCK_CLIENT_ID", "ACCESS_CODE_ENC_KEY_BASE64", "APP_URL"]
      .filter(k => !env[k]).map(k => `${k}_MISSING`),
    ...(!env.PUBLIC_API_BASE_URL && !env.API_BASE_URL ? ["PUBLIC_API_BASE_URL_MISSING"] : []),
    ...(env.GUEST_SMS_ENABLED !== "1" ? ["GUEST_SMS_DISABLED"] : []),
  ];
  return { ready: blockers.length === 0, blockers, property: { id: property.id, name: property.name,
    timezone: property.timezone, cleaningStartOffsetMinutes: property.cleaningStartOffsetMinutes,
    cleaningAccessMinutes: 30 }, primaryAdmin, cleaner: cleaner ? { id: cleaner.staffMemberId,
      name: cleaner.staffMember.fullName, phone: cleaner.staffMember.phoneE164, language: cleaner.staffMember.preferredLanguage } : null,
    lock: property.locks[0] ? { id: property.locks[0].id, name: property.locks[0].displayName ?? property.locks[0].ttlockLockName } : null };
}

export async function readDemoRun(db: PrismaClient, actor: DemoActor, id: string) {
  authorize(actor); requestId(id);
  const r = await db.reservation.findFirst({ where: { propertyId: INTERNAL_DEMO_PROPERTY_ID,
    externalProvider: INTERNAL_DEMO_PROVIDER, externalId: `DEMO-${id}`, property: { organizationId: actor.organizationId } },
    include: { property: true, accessGrants: { select: { id: true, type: true, status: true, startsAt: true,
      endsAt: true, lastError: true, accessCodeMasked: true, lock: { select: { displayName: true, ttlockLockName: true } } } },
      NfcAssignment: { select: { id: true, role: true, status: true, startsAt: true, endsAt: true, lastError: true } } } });
  if (!r || !isInternalDemo(r)) throw new DemoRunError("DEMO_RUN_NOT_FOUND", 404);
  const [messages, confirmations, work, conversation, incidents] = await Promise.all([
    db.messageLog.findMany({ where: { reservationId: r.id, organizationId: actor.organizationId }, orderBy: { createdAt: "asc" },
      select: { id: true, channel: true, to: true, status: true, providerDeliveryStatus: true, communicationType: true, createdAt: true } }),
    db.cleaningConfirmation.findMany({ where: { reservationId: r.id }, select: { id: true, status: true, staffMemberId: true } }),
    db.cleaningWork.findMany({ where: { reservationId: r.id }, select: { startConfirmedAt: true, completionConfirmedAt: true, cancelledAt: true } }),
    db.pinAIGuestConversation.findUnique({ where: { reservationId: r.id }, select: { id: true, updatedAt: true } }),
    db.operationalIssue.findMany({ where: { reservationId: r.id, organizationId: actor.organizationId, engine: "PIN_AI_GUEST_INCIDENT" },
      select: { metadata: true, workflowState: true, hostThread: { select: { acknowledgedAt: true, messages: { where: { kind: "PUBLISH", audience: "GUEST" }, select: { id: true } } } } } }),
  ]);
  const raw = r.externalRaw as Record<string, any>;
  const origin = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  let cleaningWindow = null;
  try { cleaningWindow = await readCleanerAccessWindow(db, r); } catch { /* shown as unavailable */ }
  return { requestId: id, reservation: { id: r.id, reservationNumber: r.reservationNumber, guestName: r.guestName,
    checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, accessGrants: r.accessGrants, NfcAssignment: r.NfcAssignment },
    propertyName: r.property.name, timezone: r.property.timezone, paymentSimulated: true,
    identitySimulated: true, paymentState: r.paymentState,
    stage: raw.demoRun?.stage ?? "CREATED", lastError: raw.demoRun?.lastError ?? null,
    secureReady: r.guestAccessReleaseStatus === "ELIGIBLE" || r.guestAccessReleaseStatus === "RELEASED",
    manageReservationUrl: r.guestToken ? `${origin}/booking/manage/${encodeURIComponent(r.guestToken)}` : null,
    messages: messages.map(m => ({ ...m, delivery: demoMessageState(m) })), confirmations, cleaningWork: work, cleaningWindow,
    pinAI: { conversationStarted: !!conversation, lastActivityAt: conversation?.updatedAt ?? null },
    incidents: incidents.map(i => ({ reference: (i.metadata as any)?.reference, state: i.workflowState,
      hostAcknowledged: !!i.hostThread?.acknowledgedAt, publishedReplies: i.hostThread?.messages.length ?? 0,
      url: `${origin}/pin-ai/incidents/${(i.metadata as any)?.reference}` })),
    demonstrationComplete: false,
  };
}

export async function runInternalDemo(db: PrismaClient, actor: DemoActor, body: any,
  deps = dependencies, env = process.env) {
  authorize(actor);
  const id = requestId(body?.requestId);
  const input = { checkIn: new Date(body.checkIn), checkOut: new Date(body.checkOut),
    guestName: String(body.guestName ?? "").trim(), guestEmail: String(body.guestEmail ?? "").trim().toLowerCase(),
    guestPhone: String(body.guestPhone ?? "").trim(), preferredLanguage: body.preferredLanguage as "es" | "en",
    smsConsent: body.smsConsent === true, cleanerId: String(body.cleanerId ?? ""),
    primaryAdminEmail: String(body.primaryAdminEmail ?? "").toLowerCase(), afterHoursAuthorized: body.afterHoursAuthorized === true };
  if (!Number.isFinite(input.checkIn.getTime()) || !Number.isFinite(input.checkOut.getTime()) || input.checkOut <= input.checkIn ||
    !input.guestName || input.guestName.length > 120 || input.guestEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.guestEmail) ||
    !["es", "en"].includes(input.preferredLanguage) || (input.guestPhone && !/^\+[1-9]\d{7,14}$/.test(input.guestPhone)) ||
    !input.smsConsent || !input.guestPhone || !input.afterHoursAuthorized) throw new DemoRunError("DEMO_INPUT_INVALID", 400, true);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  let reservationId: string | undefined;
  let stage = "PREPARATION";
  // The property-scoped lock serializes Demo commands only. Services retain their
  // own durable transactions; a timeout can be resumed through the same request.
  try {
    await db.$transaction(async lockTx => {
      await lockTx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `demo-run:${actor.organizationId}:${INTERNAL_DEMO_PROPERTY_ID}`);
      const existing = await db.reservation.findFirst({ where: { propertyId: INTERNAL_DEMO_PROPERTY_ID,
        externalProvider: INTERNAL_DEMO_PROVIDER, externalId: `DEMO-${id}` }, include: { property: true } });
      if (existing) {
        if (!isInternalDemo(existing) || existing.property.organizationId !== actor.organizationId ||
          (existing.externalRaw as any)?.demoRun?.fingerprint !== fingerprint) throw new DemoRunError("DEMO_REQUEST_CONFLICT");
        reservationId = existing.id;
      } else {
        const prep = await readDemoPreparation(db, actor, env);
        if (!prep.ready) throw new DemoRunError(`DEMO_PREPARATION_REQUIRED:${prep.blockers.join(",")}`, 409, true);
        if (prep.cleaner?.id !== input.cleanerId || prep.primaryAdmin?.email.toLowerCase() !== input.primaryAdminEmail) throw new DemoRunError("DEMO_RECIPIENTS_CHANGED", 409, true);
        if (input.checkOut <= new Date()) throw new DemoRunError("DEMO_DATES_EXPIRED", 409, true);
        stage = "CREATION";
        const ingested = await deps.ingest({ source: INTERNAL_DEMO_SOURCE, propertyId: INTERNAL_DEMO_PROPERTY_ID,
          guestName: input.guestName, guestEmail: input.guestEmail, guestPhone: input.guestPhone || null,
          preferredLanguage: input.preferredLanguage, adults: 1, children: 0, roomName: prep.property.name,
          checkIn: input.checkIn.toISOString(), checkOut: input.checkOut.toISOString(), paymentState: "PAID",
          totalAmount: 0, currency: "usd", externalProvider: INTERNAL_DEMO_PROVIDER, externalId: `DEMO-${id}`,
          externalUpdatedAt: new Date().toISOString(), status: "ACTIVE", externalRaw: { demo: true, paymentSimulated: true,
            demoRun: { requestId: id, fingerprint, stage, cleanerId: input.cleanerId, afterHoursAuthorized: true,
              primaryAdminEmail: input.primaryAdminEmail, actorUserId: actor.userId },
            consent: { stayNotificationsConsent: input.smsConsent, smsConsent: input.smsConsent, consentSource: "INTERNAL_DEMO_CENTER" },
            created_by: actor.email ?? actor.userId } });
        reservationId = ingested.reservationId;
      }
      const setStage = async (next: string, lastError: string | null = null) => {
        stage = next;
        const r = await db.reservation.findUniqueOrThrow({ where: { id: reservationId! } });
        const raw = r.externalRaw as Record<string, any>;
        await db.reservation.update({ where: { id: r.id }, data: { externalRaw: { ...raw,
          demoRun: { ...raw.demoRun, stage, lastError } } } });
      };
      const current = await db.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      if ((current.externalRaw as any)?.demoRun?.stage === "READY") return;
      if (current.checkOut <= new Date()) throw new DemoRunError("DEMO_DATES_EXPIRED");
      await setStage("SECURE_PRECHECKIN");
      if (!current.guestAgreementSignedAt) await deps.secure(db, { reservationId: reservationId!, actor,
        delivery: { preferredLanguage: input.preferredLanguage, smsConsent: input.smsConsent } });
      await setStage("CONFIRMATIONS");
      const parity = await deps.parity(db, { reservationId: reservationId!, preferredLanguage: input.preferredLanguage });
      if (!parity.guestEmail.ok || parity.hostEmail.sent !== 1) throw new DemoRunError("DEMO_EMAIL_ATTENTION_REQUIRED");
      await setStage("CLEANER_INVITATION");
      const dispatched = await deps.cleaning({ prisma: db, reservationId: reservationId! });
      if (!dispatched.ok) throw new DemoRunError(`DEMO_CLEANER_ATTENTION_REQUIRED:${dispatched.reason}`);
      await setStage("READY");
    }, { timeout: 120_000, maxWait: 10_000 });
    return { ok: true, data: await readDemoRun(db, actor, id) };
  } catch (error) {
    const code = error instanceof DemoRunError ? error.code : `DEMO_${stage}_FAILED`;
    // Recover the persisted reservation even if ingest committed before throwing.
    let data = await readDemoRun(db, actor, id).catch(() => null);
    if (data && code !== "DEMO_REQUEST_CONFLICT") {
      const current = await db.reservation.findUniqueOrThrow({ where: { id: data.reservation.id } });
      const raw = current.externalRaw as Record<string, any>;
      // Do not overwrite a concurrent resume that has already moved on.
      if (raw.demoRun?.stage === stage && stage !== "READY") {
        await db.reservation.updateMany({ where: { id: current.id, externalRaw: { equals: raw } },
          data: { externalRaw: { ...raw, demoRun: { ...raw.demoRun, lastError: code } } } });
      }
      data = await readDemoRun(db, actor, id);
      return { ok: false, error: code, data };
    }
    throw error instanceof DemoRunError ? error : new DemoRunError(code);
  }
}
