import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { estimateStayTimeAdjustmentInTransaction } from "./stay-time-estimate.service.js";
import { calculateDirectBookingModificationConnectFee } from "./direct-booking-connect-fee.service.js";
import { reservationStateFingerprint } from "../pin-ai/actions/reservation-state-fingerprint.js";
import { StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";

function reject(code: string): never { throw new StayTimePolicyError(code); }
/** Decimal money/rates to hundredths without floating-point multiplication. */
function hundredths(value: unknown): number {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) reject("STAY_TIME_FINANCIAL_VALUE_INVALID");
  const [whole, fraction = ""] = text.split(".");
  return safe(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")));
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) reject("STAY_TIME_FINANCIAL_OVERFLOW");
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("STAY_TIME_PRICING_SNAPSHOT_REQUIRED");
  return value as Record<string, unknown>;
}

/** Incremental service pricing only; existing nightly/cleaning/amenity charges
 * are retained verbatim and never sent back through the nightly rate engine. */
export function priceStayTimeService(input: {
  currency: string; currentTotal: string; pricingBreakdown: unknown; feeSubtotalMinor: number;
  taxes: readonly { id: string; name: string; percentage: string; updatedAt: string }[];
  platformFeePercent: string;
}) {
  if (input.currency.toUpperCase() !== "USD") reject("CURRENCY_MISMATCH");
  if (!Number.isSafeInteger(input.feeSubtotalMinor) || input.feeSubtotalMinor < 0) reject("INVALID_FEE_POLICY");
  const base = object(input.pricingBreakdown);
  const currentTotalMinor = hundredths(input.currentTotal);
  if (String(base.currency).toUpperCase() !== "USD" || hundredths(base.totalAmount) !== currentTotalMinor ||
      (base.totalAmountCents !== undefined && base.totalAmountCents !== currentTotalMinor)) reject("STAY_TIME_PRICING_SNAPSHOT_MISMATCH");
  const feeRate = hundredths(input.platformFeePercent);
  if (feeRate > 10_000) reject("STAY_TIME_PLATFORM_FEE_INVALID");
  const ids = new Set<string>();
  const taxes = [...input.taxes].sort((a, b) => a.id.localeCompare(b.id)).map(tax => {
    if (!tax.id || ids.has(tax.id) || !tax.name || !Number.isFinite(Date.parse(tax.updatedAt))) reject("STAY_TIME_TAX_CONFIGURATION_INVALID");
    ids.add(tax.id);
    const rateBasisPoints = hundredths(tax.percentage);
    if (rateBasisPoints > 10_000) reject("STAY_TIME_TAX_CONFIGURATION_INVALID");
    const amountMinor = safe((BigInt(input.feeSubtotalMinor) * BigInt(rateBasisPoints) + 5_000n) / 10_000n);
    return { ...tax, rateBasisPoints, amountMinor };
  });
  const taxTotalMinor = safe(taxes.reduce((sum, tax) => sum + BigInt(tax.amountMinor), 0n));
  const additionalChargeMinor = safe(BigInt(input.feeSubtotalMinor) + BigInt(taxTotalMinor));
  const proposedTotalMinor = safe(BigInt(currentTotalMinor) + BigInt(additionalChargeMinor));
  const split = additionalChargeMinor === 0 ? { additionalPlatformFeeAmountCents: 0, additionalHostPayoutAmountCents: 0 }
    : calculateDirectBookingModificationConnectFee({ additionalChargeAmountCents: additionalChargeMinor, platformFeePercent: feeRate / 100 });
  return { currency: "USD" as const, pricingBasis: "ADDITIONAL_STAY_TIME_ONLY" as const,
    basePricingSnapshot: structuredClone(base), currentTotalMinor, proposedTotalMinor,
    serviceSubtotalMinor: input.feeSubtotalMinor, taxes, taxTotalMinor, additionalChargeMinor,
    platformFeeBasisPoints: feeRate, additionalPlatformFeeMinor: split.additionalPlatformFeeAmountCents,
    additionalHostPayoutMinor: split.additionalHostPayoutAmountCents, additionalIdentityFeeMinor: 0,
    financialAction: additionalChargeMinor === 0 ? "NO_PAYMENT_REQUIRED" as const : "ADDITIONAL_PAYMENT_REQUIRED" as const };
}

/** Internal, read-only financial quote. No confirmable proposal is persisted yet. */
export async function prepareStayTimeQuote(db: Pick<PrismaClient, "$transaction">, input: {
  guestToken: string; operation: StayTimeOperation; requestedLocalTime: string;
}, options: { now?: Date; platformFeePercent: string }) {
  return db.$transaction(tx => prepareStayTimeQuoteInTransaction(tx, input, options), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 10000,
  });
}

/** Also used by proposal creation/confirmation inside their serializable transaction. */
export async function prepareStayTimeQuoteInTransaction(tx: Prisma.TransactionClient, input: {
  guestToken: string; operation: StayTimeOperation; requestedLocalTime: string;
}, options: { now?: Date; platformFeePercent: string; ownModificationId?: string }) {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(input.guestToken)) reject("INVALID_GUEST_TOKEN");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) reject("INVALID_STAY_TIME");
    const reservation = await tx.reservation.findFirst({
      where: { guestToken: input.guestToken, status: "ACTIVE", property: { status: "ACTIVE" },
        OR: [{ guestTokenExpiresAt: null }, { guestTokenExpiresAt: { gt: now } }] },
      include: { property: { select: { organizationId: true,
        taxes: { where: { isActive: true }, orderBy: { id: "asc" },
          select: { id: true, name: true, percentage: true, updatedAt: true } } } } },
    });
    if (!reservation) reject("STAY_TIME_RESERVATION_NOT_FOUND");
    const estimate = await estimateStayTimeAdjustmentInTransaction(tx, {
      organizationId: reservation.property.organizationId, propertyId: reservation.propertyId,
      reservationId: reservation.id, operation: input.operation, requestedLocalTime: input.requestedLocalTime,
    }, now, options.ownModificationId);
    if (reservation.totalAmount === null || reservation.currency === null) reject("STAY_TIME_PRICING_SNAPSHOT_REQUIRED");
    const pricing = priceStayTimeService({ currency: reservation.currency,
      currentTotal: reservation.totalAmount.toString(), pricingBreakdown: reservation.pricingBreakdown,
      feeSubtotalMinor: estimate.feeSubtotalMinor, platformFeePercent: options.platformFeePercent,
      taxes: reservation.property.taxes.map(tax => ({ ...tax, percentage: tax.percentage.toString(), updatedAt: tax.updatedAt.toISOString() })) });
    const expiresAt = new Date(Math.min(now.getTime() + 60_000,
      reservation.guestTokenExpiresAt?.getTime() ?? Infinity,
      reservation.checkOut.getTime(), new Date(estimate.checkIn).getTime() > now.getTime()
        ? new Date(estimate.checkIn).getTime() : Infinity));
    const terms = { version: "stay_time_quote_v1", organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId, reservationId: reservation.id,
      reservationStateFingerprint: reservationStateFingerprint(reservation),
      operation: input.operation, requestedLocalTime: input.requestedLocalTime,
      currentCheckIn: reservation.checkIn.toISOString(), currentCheckOut: reservation.checkOut.toISOString(),
      proposedCheckIn: estimate.checkIn, proposedCheckOut: estimate.checkOut,
      policyVersion: estimate.policyVersion, settingsRevision: estimate.settingsRevision,
      hourlyPricingBasis: estimate.hourlyPricingBasis,
      arrivalReadinessEvidenceId: estimate.arrivalReadinessEvidenceId,
      requiredFreeFrom: estimate.requiredFreeFrom, requiredFreeUntil: estimate.requiredFreeUntil,
      pricing, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
    const fingerprint = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
    return { terms, fingerprint, requiresGuestConfirmation: true as const, confirmationAvailable: false as const,
      paymentReady: false as const, authorizationGranted: false as const, actionExecuted: false as const,
      availabilityHeld: false as const };
}
