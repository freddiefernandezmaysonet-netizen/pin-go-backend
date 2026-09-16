import type { PrismaClient } from "@prisma/client";

type StripeFinancialAdapterDb = Pick<
  PrismaClient,
  "stripeEventLog" | "reservation"
>;

type JsonRecord = Record<string, unknown>;

type LedgerRow = {
  stripeId: string;
  type: string;
  livemode: boolean | null;
  payload: unknown;
  createdAt: Date;
};

type ReservationRow = {
  id: string;
  createdAt: Date;
  currency: string | null;
  amountCollected: unknown;
  amountRefunded: unknown;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeTransferId: string | null;
  stripeApplicationFeeId: string | null;
  basePlatformFeeAmount: unknown;
  platformFeeAmount: unknown;
  hostPayoutAmount: unknown;
  externalRaw: unknown;
};

export type StripeFinancialReconciliationStatus =
  | "NO_FINANCIAL_ACTIVITY"
  | "REQUIRES_BALANCE_TRANSACTION_RECONCILIATION"
  | "REQUIRES_CURRENCY_RECONCILIATION"
  | "REQUIRES_LIVEMODE_RECONCILIATION";

export type StripeFinancialActuals = {
  saasRevenueActual: number;
  connectPlatformFeesActual: number;
  guestBookingGmv: number;
  hostTransfers: number;
  refunds: number;
  disputes: number;
  stripeProcessingFeesActual: null;
  netPlatformRevenue: null;
  reconciliationStatus: StripeFinancialReconciliationStatus;
  ledgerEventCount: number;
  livemode: boolean | null;
};

export type StripeFinancialAdapterOptions = {
  since: Date;
  now?: Date;
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value !== null &&
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function dollarsFromCents(value: unknown): number | null {
  const cents = asFiniteNumber(value);
  if (cents === null || cents < 0) return null;
  return cents / 100;
}

function dollarsFromDecimal(value: unknown): number | null {
  const amount = asFiniteNumber(value);
  if (amount === null || amount < 0) return null;
  return amount;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function eventRecord(row: LedgerRow) {
  return asRecord(row.payload);
}

function eventObject(row: LedgerRow) {
  const event = eventRecord(row);
  const data = asRecord(event?.data);
  return asRecord(data?.object);
}

function eventTimestamp(row: LedgerRow) {
  const created = asFiniteNumber(eventRecord(row)?.created);
  if (created !== null && created >= 0) {
    const value = new Date(created * 1000);
    if (!Number.isNaN(value.getTime())) return value;
  }
  return row.createdAt;
}

function rowLivemode(row: LedgerRow) {
  if (typeof row.livemode === "boolean") return row.livemode;
  const payloadValue = eventRecord(row)?.livemode;
  return typeof payloadValue === "boolean" ? payloadValue : null;
}

function currencyIsUsd(
  object: JsonRecord,
  markUnsupported: () => void
) {
  const currency = asString(object.currency)?.toLowerCase();
  if (currency === "usd") return true;
  markUnsupported();
  return false;
}

function directBookingFlow(object: JsonRecord) {
  const metadata = asRecord(object.metadata);
  const flow = asString(metadata?.flow)?.toLowerCase();
  return (
    flow === "direct_booking" ||
    flow === "direct_booking_reservation_modification"
  );
}

function refundIdsFromExternalRaw(value: unknown) {
  const ids = new Set<string>();
  const raw = asRecord(value);
  const refund = asRecord(raw?.refund);
  for (const candidate of [refund?.id, refund?.stripeRefundId]) {
    const id = asString(candidate);
    if (id) ids.add(id);
  }
  return ids;
}

function sumMap(values: Map<string, number>) {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

function chooseLedgerMode(rows: LedgerRow[]) {
  const modes = new Set<boolean>();
  for (const row of rows) {
    const mode = rowLivemode(row);
    if (mode !== null) modes.add(mode);
  }

  if (modes.has(true)) {
    return { livemode: true, mixed: modes.has(false), unknown: false };
  }
  if (modes.has(false)) {
    return { livemode: false, mixed: false, unknown: false };
  }
  return {
    livemode: null,
    mixed: false,
    unknown: rows.length > 0,
  };
}

function isReservationInWindow(row: ReservationRow, since: Date, now: Date) {
  return row.createdAt >= since && row.createdAt <= now;
}

export async function getStripeFinancialActuals(
  db: StripeFinancialAdapterDb,
  options: StripeFinancialAdapterOptions
): Promise<StripeFinancialActuals> {
  const now = options.now ?? new Date();
  const since = options.since;

  const ledgerRows = (await db.stripeEventLog.findMany({
    where: {
      createdAt: {
        gte: since,
        lte: now,
      },
      processedAt: {
        not: null,
      },
      error: null,
    },
    select: {
      stripeId: true,
      type: true,
      livemode: true,
      payload: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  })) as LedgerRow[];

  const inWindowRows = ledgerRows.filter((row) => {
    const createdAt = eventTimestamp(row);
    return createdAt >= since && createdAt <= now;
  });

  const mode = chooseLedgerMode(inWindowRows);
  const scopedRows =
    mode.livemode === null
      ? inWindowRows
      : inWindowRows.filter((row) => rowLivemode(row) === mode.livemode);

  let unsupportedCurrency = false;
  const markUnsupportedCurrency = () => {
    unsupportedCurrency = true;
  };

  const invoices = new Map<string, number>();
  const applicationFees = new Map<string, number>();
  const guestCheckoutSessions = new Map<string, number>();
  const transfers = new Map<string, number>();
  const refunds = new Map<
    string,
    { amount: number; chargeId: string | null; paymentIntentId: string | null }
  >();
  const disputes = new Map<
    string,
    { amount: number; chargeId: string | null }
  >();

  for (const row of scopedRows) {
    const object = eventObject(row);
    if (!object) continue;

    if (row.type === "invoice.paid") {
      const id = asString(object.id);
      const amount = dollarsFromCents(object.amount_paid);
      if (
        id &&
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        invoices.set(id, amount);
      }
      continue;
    }

    if (
      row.type.startsWith("application_fee.") &&
      object.object === "application_fee"
    ) {
      const id = asString(object.id);
      const amount = dollarsFromCents(object.amount);
      const amountRefunded = dollarsFromCents(object.amount_refunded) ?? 0;
      if (
        id &&
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        applicationFees.set(id, Math.max(amount - amountRefunded, 0));
      }
      continue;
    }

    if (
      (row.type === "checkout.session.completed" ||
        row.type === "checkout.session.async_payment_succeeded") &&
      directBookingFlow(object) &&
      asString(object.payment_status)?.toLowerCase() === "paid"
    ) {
      const id = asString(object.id);
      const amount = dollarsFromCents(object.amount_total);
      if (
        id &&
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        guestCheckoutSessions.set(id, amount);
      }
      continue;
    }

    if (row.type === "transfer.created" && object.object === "transfer") {
      const id = asString(object.id);
      const amount = dollarsFromCents(object.amount);
      if (
        id &&
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        transfers.set(id, amount);
      }
      continue;
    }

    if (row.type.startsWith("refund.") && object.object === "refund") {
      const id = asString(object.id);
      const status = asString(object.status)?.toLowerCase();
      if (!id) continue;
      if (status !== "succeeded") {
        refunds.delete(id);
        continue;
      }
      const amount = dollarsFromCents(object.amount);
      if (
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        refunds.set(id, {
          amount,
          chargeId: asString(object.charge),
          paymentIntentId: asString(object.payment_intent),
        });
      }
      continue;
    }

    if (row.type === "charge.dispute.created") {
      const id = asString(object.id);
      const amount = dollarsFromCents(object.amount);
      if (
        id &&
        amount !== null &&
        currencyIsUsd(object, markUnsupportedCurrency)
      ) {
        disputes.set(id, {
          amount,
          chargeId: asString(object.charge),
        });
      }
    }
  }

  const relatedChargeIds = new Set<string>();
  const relatedPaymentIntentIds = new Set<string>();
  for (const refund of refunds.values()) {
    if (refund.chargeId) relatedChargeIds.add(refund.chargeId);
    if (refund.paymentIntentId) {
      relatedPaymentIntentIds.add(refund.paymentIntentId);
    }
  }
  for (const dispute of disputes.values()) {
    if (dispute.chargeId) relatedChargeIds.add(dispute.chargeId);
  }

  const reservationRows = (await db.reservation.findMany({
    where: {
      AND: [
        {
          OR: [
            { source: "DIRECT_BOOKING" },
            { externalProvider: "PIN_GO_DIRECT" },
            { stripeCheckoutSessionId: { not: null } },
          ],
        },
        {
          OR: [
            { createdAt: { gte: since, lte: now } },
            { stripeChargeId: { in: [...relatedChargeIds] } },
            {
              stripePaymentIntentId: {
                in: [...relatedPaymentIntentIds],
              },
            },
            { stripeTransferId: { in: [...transfers.keys()] } },
          ],
        },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      currency: true,
      amountCollected: true,
      amountRefunded: true,
      stripeCheckoutSessionId: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
      stripeTransferId: true,
      stripeApplicationFeeId: true,
      basePlatformFeeAmount: true,
      platformFeeAmount: true,
      hostPayoutAmount: true,
      externalRaw: true,
    },
  })) as ReservationRow[];

  const bookingChargeIds = new Set<string>();
  const bookingPaymentIntentIds = new Set<string>();
  const bookingRefundIds = new Set<string>();

  let reservationGmvFallback = 0;
  let reservationPlatformFeeFallback = 0;
  let reservationTransferFallback = 0;
  let reservationRefundFallback = 0;

  for (const reservation of reservationRows) {
    if (reservation.stripeChargeId) {
      bookingChargeIds.add(reservation.stripeChargeId);
    }
    if (reservation.stripePaymentIntentId) {
      bookingPaymentIntentIds.add(reservation.stripePaymentIntentId);
    }
    const reservationRefundIds = refundIdsFromExternalRaw(
      reservation.externalRaw
    );
    for (const refundId of reservationRefundIds) {
      bookingRefundIds.add(refundId);
    }

    if (!isReservationInWindow(reservation, since, now)) continue;

    const currency = asString(reservation.currency)?.toLowerCase();
    if (currency !== "usd") {
      unsupportedCurrency = true;
      continue;
    }

    const checkoutSessionId = reservation.stripeCheckoutSessionId;
    if (
      checkoutSessionId &&
      !guestCheckoutSessions.has(checkoutSessionId)
    ) {
      reservationGmvFallback +=
        dollarsFromDecimal(reservation.amountCollected) ?? 0;
    }

    const applicationFeeId = reservation.stripeApplicationFeeId;
    if (applicationFeeId && !applicationFees.has(applicationFeeId)) {
      reservationPlatformFeeFallback +=
        dollarsFromDecimal(
          reservation.basePlatformFeeAmount ?? reservation.platformFeeAmount
        ) ?? 0;
    }

    const transferId = reservation.stripeTransferId;
    if (transferId && !transfers.has(transferId)) {
      reservationTransferFallback +=
        dollarsFromDecimal(reservation.hostPayoutAmount) ?? 0;
    }

    const refundAmount = dollarsFromDecimal(reservation.amountRefunded) ?? 0;
    if (refundAmount > 0) {
      let ledgerRefundAmountForReservation = 0;
      for (const [refundId, refund] of refunds.entries()) {
        const matchesReservation =
          reservationRefundIds.has(refundId) ||
          (refund.chargeId !== null &&
            refund.chargeId === reservation.stripeChargeId) ||
          (refund.paymentIntentId !== null &&
            refund.paymentIntentId === reservation.stripePaymentIntentId);
        if (matchesReservation) {
          ledgerRefundAmountForReservation += refund.amount;
        }
      }

      reservationRefundFallback += Math.max(
        refundAmount - ledgerRefundAmountForReservation,
        0
      );
    }
  }

  let bookingRefundsFromLedger = 0;
  for (const [refundId, refund] of refunds.entries()) {
    const belongsToBooking =
      bookingRefundIds.has(refundId) ||
      (refund.chargeId !== null && bookingChargeIds.has(refund.chargeId)) ||
      (refund.paymentIntentId !== null &&
        bookingPaymentIntentIds.has(refund.paymentIntentId));

    if (belongsToBooking) bookingRefundsFromLedger += refund.amount;
  }

  let bookingDisputesFromLedger = 0;
  for (const dispute of disputes.values()) {
    if (dispute.chargeId && bookingChargeIds.has(dispute.chargeId)) {
      bookingDisputesFromLedger += dispute.amount;
    }
  }

  let bookingTransfersFromLedger = 0;
  for (const reservation of reservationRows) {
    if (!reservation.stripeTransferId) continue;
    const amount = transfers.get(reservation.stripeTransferId);
    if (amount !== undefined) bookingTransfersFromLedger += amount;
  }

  const saasRevenueActual = money(sumMap(invoices));
  const connectPlatformFeesActual = money(
    sumMap(applicationFees) + reservationPlatformFeeFallback
  );
  const guestBookingGmv = money(
    sumMap(guestCheckoutSessions) + reservationGmvFallback
  );
  const hostTransfers = money(
    bookingTransfersFromLedger + reservationTransferFallback
  );
  const refundTotal = money(
    bookingRefundsFromLedger + reservationRefundFallback
  );
  const disputeTotal = money(bookingDisputesFromLedger);

  const hasFinancialActivity =
    saasRevenueActual > 0 ||
    connectPlatformFeesActual > 0 ||
    guestBookingGmv > 0 ||
    hostTransfers > 0 ||
    refundTotal > 0 ||
    disputeTotal > 0 ||
    scopedRows.length > 0;

  let reconciliationStatus: StripeFinancialReconciliationStatus;
  if (mode.mixed || mode.unknown) {
    reconciliationStatus = "REQUIRES_LIVEMODE_RECONCILIATION";
  } else if (unsupportedCurrency) {
    reconciliationStatus = "REQUIRES_CURRENCY_RECONCILIATION";
  } else if (hasFinancialActivity) {
    reconciliationStatus =
      "REQUIRES_BALANCE_TRANSACTION_RECONCILIATION";
  } else {
    reconciliationStatus = "NO_FINANCIAL_ACTIVITY";
  }

  return {
    saasRevenueActual,
    connectPlatformFeesActual,
    guestBookingGmv,
    hostTransfers,
    refunds: refundTotal,
    disputes: disputeTotal,
    stripeProcessingFeesActual: null,
    netPlatformRevenue: null,
    reconciliationStatus,
    ledgerEventCount: scopedRows.length,
    livemode: mode.livemode,
  };
}
