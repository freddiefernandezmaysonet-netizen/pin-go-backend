import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DAMAGE_PAYMENT_AUTHORIZATION_VERSION,
  evaluateDamageChargeEligibility,
} from "./damage-case-charge-eligibility.policy.js";

export class DamagePaymentAuthorizationError extends Error {
  constructor(public code: string, public statusCode = 409) {
    super(code);
    this.name = "DamagePaymentAuthorizationError";
  }
}
const fail = (code: string, statusCode = 409): never => {
  throw new DamagePaymentAuthorizationError(code, statusCode);
};
export const PAYMENT_AUTHORIZATION_ACTION = "ACCEPT_AND_AUTHORIZE_PAYMENT";

const include = {
  property: { include: { organization: true } },
  damageCase: { include: { paymentAuthorization: true } },
} satisfies Prisma.ReservationInclude;
type Reservation = Prisma.ReservationGetPayload<{ include: typeof include }>;
type Language = "en" | "es";

// Decimal -> integer cents without binary floating point rounding or coercion.
export function damageAmountMinor(value: Prisma.Decimal | null): number {
  if (!value) return fail("INVALID_AMOUNT");
  const cents = value.mul(100);
  if (!cents.isFinite() || !cents.isInteger() || cents.lte(0) || cents.gt(2147483647))
    return fail("INVALID_AMOUNT");
  return cents.toNumber();
}
function object(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
// Key ordering in JSONB must not change the revision across reads.
export function canonicalDamageTerms(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDamageTerms).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalDamageTerms(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function damageAuthorizationText(amountMinor: number, language: Language) {
  const amount = `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")} USD`;
  return language === "es"
    ? `Autorizo al anfitrión a cobrar ${amount} a mi método de pago guardado por este expediente de Property Protection, a través de Pin&Go. Esta autorización es adicional a mi aceptación del expediente. Registrar esta autorización no realiza ningún cargo.`
    : `I authorize the host to charge ${amount} to my saved payment method for this Property Protection case through Pin&Go. This authorization is separate from my acceptance of the case. Recording this authorization does not make a charge.`;
}

function buildTerms(reservation: Reservation, now: Date, language: Language) {
  const dc = reservation.damageCase;
  if (!dc) return fail("CASE_UNAVAILABLE", 404);
  const account = reservation.stripeConnectedAccountId;
  if (!account || !account.startsWith("acct_") || account !== reservation.property.organization.stripeConnectAccountId)
    return fail("CONNECTED_ACCOUNT_MISMATCH");
  const maximum = damageAmountMinor(reservation.maxDamageLiabilityAmountSnapshot);
  const amount = damageAmountMinor(dc.approvedAmount);
  const policy = object(reservation.propertyProtectionPolicySnapshot);
  const consent = object(reservation.damagePaymentConsent);
  if (policy.currency !== "usd" || consent.currency !== "usd" || consent.accepted !== true ||
      reservation.currency !== "usd") return fail("BOOKING_CONSENT_REQUIRED");
  for (const captured of [policy, consent]) {
    const capturedMaximum = captured.maxDamageLiabilityAmount;
    if ((typeof capturedMaximum !== "number" && typeof capturedMaximum !== "string") ||
        !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(capturedMaximum)) ||
        damageAmountMinor(new Prisma.Decimal(capturedMaximum)) !== maximum ||
        captured.mode !== "CARD_ON_FILE") return fail("BOOKING_CONSENT_REQUIRED");
  }
  if (policy.enabled !== true) return fail("BOOKING_CONSENT_REQUIRED");
  if (reservation.damagePaymentMethodStatus !== "READY" ||
      !reservation.stripeDamageCustomerId?.startsWith("cus_") ||
      !reservation.stripeDamagePaymentMethodId?.startsWith("pm_")) return fail("CARD_ON_FILE_NOT_READY");
  if (amount > damageAmountMinor(dc.requestedAmount)) return fail("INVALID_AMOUNT");
  const snapshot = {
    version: DAMAGE_PAYMENT_AUTHORIZATION_VERSION,
    organizationId: reservation.property.organizationId,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    damageCaseId: dc.id,
    connectedAccountId: account,
    checkOut: reservation.checkOut.toISOString(),
    reportedAmountMinor: damageAmountMinor(dc.requestedAmount),
    amountMinor: amount,
    acceptedMaximumMinor: maximum,
    currency: dc.currency,
    description: dc.description,
    evidence: dc.evidence,
    hostApprovedAt: dc.hostApprovedAt?.toISOString() ?? null,
    hostApprovedByUserId: dc.hostApprovedByUserId,
    guestNotifiedAt: dc.guestNotifiedAt?.toISOString() ?? null,
    bookingConsent: reservation.damagePaymentConsent,
    protectionPolicy: reservation.propertyProtectionPolicySnapshot,
    // Replacing a saved method must invalidate an older authorization revision.
    customerId: reservation.stripeDamageCustomerId,
    paymentMethodId: reservation.stripeDamagePaymentMethodId,
  };
  const claimRevision = createHash("sha256").update(canonicalDamageTerms(snapshot)).digest("hex");
  const eligibility = evaluateDamageChargeEligibility({
    now, checkOut: reservation.checkOut,
    directBooking: reservation.source === "DIRECT_BOOKING" || reservation.externalProvider === "PIN_GO_DIRECT" || Boolean(reservation.stripeCheckoutSessionId),
    protectionEnabled: reservation.propertyProtectionRequiredSnapshot === true,
    protectionMode: reservation.propertyProtectionModeSnapshot ?? "",
    organizationId: snapshot.organizationId, reservationId: reservation.id,
    damageCaseId: dc.id, connectedAccountId: account, status: dc.status,
    closedAt: dc.closedAt, guestResponse: dc.guestResponse,
    hostApprovedAt: dc.hostApprovedAt, hostApprovedByUserId: dc.hostApprovedByUserId,
    guestNotifiedAt: dc.guestNotifiedAt, claimRevision,
    approvedAmountMinor: amount, acceptedMaximumMinor: maximum,
    currency: dc.currency, maximumCurrency: String(policy.currency), authorization: null,
  });
  // Reuse all existing preconditions, stopping at the missing explicit consent.
  // Do not fabricate authorization to make the eligibility policy return true.
  if (eligibility.reason !== "PAYMENT_AUTHORIZATION_REQUIRED") return fail(eligibility.reason);
  return {
    snapshot,
    publicTerms: {
      damageCaseId: dc.id, version: DAMAGE_PAYMENT_AUTHORIZATION_VERSION,
      action: PAYMENT_AUTHORIZATION_ACTION, claimRevision, amountMinor: amount,
      currency: dc.currency, acceptedMaximumMinor: maximum,
      reportedAmountMinor: snapshot.reportedAmountMinor,
      description: dc.description,
      evidenceNotes: typeof object(dc.evidence).notes === "string" ? object(dc.evidence).notes : null,
      language, consentText: damageAuthorizationText(amount, language),
      collectionStatus: "NO_CHARGE_MADE" as const,
    },
  };
}

function token(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    return fail("RESERVATION_NOT_FOUND", 404);
  return value.trim();
}
async function load(db: Prisma.TransactionClient, guestToken: string, now: Date) {
  const reservation = await db.reservation.findUnique({ where: { guestToken }, include });
  if (!reservation || (reservation.guestTokenExpiresAt && reservation.guestTokenExpiresAt <= now))
    return fail("RESERVATION_NOT_FOUND", 404);
  return reservation;
}
function language(value: unknown, preferred: string): Language {
  if (value === undefined) return preferred.toLowerCase().startsWith("es") ? "es" : "en";
  if (value !== "en" && value !== "es") return fail("INVALID_LANGUAGE", 400);
  return value;
}

export async function getDamagePaymentAuthorizationTerms(input: {
  prisma: PrismaClient; guestToken: unknown; language?: unknown;
}) {
  const now = new Date();
  const reservation = await load(input.prisma, token(input.guestToken), now);
  const terms = buildTerms(reservation, now, language(input.language, reservation.preferredLanguage));
  const existing = reservation.damageCase!.paymentAuthorization;
  return {
    ok: true, terms: terms.publicTerms,
    authorization: existing ? {
      id: existing.id, authorizedAt: existing.authorizedAt.toISOString(),
      amountMinor: existing.amountMinor, currency: existing.currency,
      matchesCurrentTerms: existing.claimRevision === terms.publicTerms.claimRevision,
    } : null,
  };
}

export async function recordDamagePaymentAuthorization(input: {
  prisma: PrismaClient; guestToken: unknown; body: unknown;
}) {
  const guestToken = token(input.guestToken);
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) return fail("INVALID_AUTHORIZATION", 400);
  const body = input.body as Record<string, unknown>;
  const fields = ["action", "version", "claimRevision", "amountMinor", "currency", "language", "consent"];
  if (Object.keys(body).some(key => !fields.includes(key)) || body.consent !== true ||
      body.action !== PAYMENT_AUTHORIZATION_ACTION || body.version !== DAMAGE_PAYMENT_AUTHORIZATION_VERSION ||
      typeof body.claimRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.claimRevision) ||
      !Number.isSafeInteger(body.amountMinor) || body.currency !== "usd" ||
      (body.language !== "en" && body.language !== "es")) return fail("INVALID_AUTHORIZATION", 400);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await input.prisma.$transaction(async db => {
        // Lock canonical records: expiry/checkout and host closure cannot race a write.
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Reservation" WHERE "guestToken" = ${guestToken} FOR UPDATE`;
        if (!rows.length) return fail("RESERVATION_NOT_FOUND", 404);
        await db.$queryRaw`SELECT "id" FROM "DamageCase" WHERE "reservationId" = ${rows[0].id} FOR UPDATE`;
        const now = new Date();
        const reservation = await load(db, guestToken, now);
        const { publicTerms: terms, snapshot } = buildTerms(reservation, now, language(body.language, reservation.preferredLanguage));
        if (body.claimRevision !== terms.claimRevision || body.amountMinor !== terms.amountMinor)
          return fail("AUTHORIZATION_TERMS_CHANGED");
        const existing = reservation.damageCase!.paymentAuthorization;
        if (existing && (existing.claimRevision !== terms.claimRevision || existing.amountMinor !== terms.amountMinor ||
            existing.organizationId !== snapshot.organizationId || existing.reservationId !== snapshot.reservationId ||
            existing.connectedAccountId !== snapshot.connectedAccountId ||
            existing.currency !== terms.currency || existing.language !== terms.language ||
            existing.version !== terms.version || existing.action !== terms.action || existing.consentText !== terms.consentText))
          return fail("AUTHORIZATION_ALREADY_RECORDED_WITH_DIFFERENT_TERMS");
        const record = existing ?? await db.damageCasePaymentAuthorization.create({ data: {
          damageCaseId: snapshot.damageCaseId, organizationId: snapshot.organizationId,
          reservationId: snapshot.reservationId, connectedAccountId: snapshot.connectedAccountId,
          claimRevision: terms.claimRevision, amountMinor: terms.amountMinor, currency: terms.currency,
          version: terms.version, action: terms.action, language: terms.language,
          consentText: terms.consentText, termsSnapshot: snapshot, authorizedAt: now,
        } });
        return { ok: true, idempotent: Boolean(existing), authorization: {
          id: record.id, authorizedAt: record.authorizedAt.toISOString(),
          amountMinor: record.amountMinor, currency: record.currency, claimRevision: record.claimRevision,
        }, collectionStatus: "NO_CHARGE_MADE" as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (
        ["P2034", "P2002"].includes(error.code) ||
        (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))
      )) {
        if (attempt < 2) continue;
        return fail("AUTHORIZATION_CONCURRENT_CHANGE");
      }
      throw error;
    }
  }
  return fail("AUTHORIZATION_CONCURRENT_CHANGE");
}
