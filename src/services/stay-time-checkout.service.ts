import type Stripe from "stripe";
import { Prisma, type PrismaClient, type Reservation, type ReservationModification } from "@prisma/client";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";
import { isStayTimeModification, validatePaidStayTimeCheckout, validatePaidStayTimeCheckoutReplay } from "./stay-time-apply-validation.service.js";
import { buildGuestReservationModificationCheckoutSessionParams } from "./guest-reservation-modification-checkout-contract.js";
import { processStayTimePayment, type StayTimePaymentFlowDependencies } from "./stay-time-payment-flow.service.js";

type Snapshot = ReservationModification & { reservation: Reservation & { property: { name: string; organizationId: string } } };
type Journal = {
  version: "stay_time_checkout_v1"; preparedAt: string; fingerprint: string;
  presentation: { propertyName: string; guestEmail: string; preferredLanguage: string; manageReservationUrl: string };
};
export type StayTimeCheckoutStripeClient = {
  checkout: { sessions: {
    create: (params: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => Promise<Stripe.Checkout.Session>;
    retrieve: (id: string, params: Stripe.Checkout.SessionRetrieveParams, options: Stripe.RequestOptions) => Promise<Stripe.Checkout.Session>;
    expire: (id: string, params: Stripe.Checkout.SessionExpireParams, options: Stripe.RequestOptions) => Promise<Stripe.Checkout.Session>;
  } };
  webhooks: { constructEvent: (payload: string | Buffer, signature: string, secret: string) => Stripe.Event };
};
export type StayTimeCheckoutDependencies = {
  client: PrismaClient; now: () => Date; stripe: StayTimeCheckoutStripeClient; livemode: boolean;
  /** Trusted deployment configuration, never a guest-provided redirect URL. */
  appUrl: string;
  assertPayoutReady: (organizationId: string) => Promise<{ connectedAccountId: string }>;
};
function reject(code: string): never { throw new StayTimePolicyError(code); }
function assertScope(m: Snapshot) {
  if (m.requestSource !== "PIN_AI_GUEST_SERVICES" || !isStayTimeModification(m.guestConfirmation) ||
      m.financialAction !== "ADDITIONAL_PAYMENT_REQUIRED" || Number(m.additionalChargeAmount) <= 0 ||
      m.currency.toUpperCase() !== "USD") reject("STAY_TIME_CHECKOUT_SCOPE_MISMATCH");
}
function assertGuest(m: Snapshot, token: string, now: Date) {
  if (!token || m.reservation.guestToken !== token ||
      (m.reservation.guestTokenExpiresAt && m.reservation.guestTokenExpiresAt <= now)) reject("STAY_TIME_CHECKOUT_SCOPE_MISMATCH");
}
async function locked<T>(deps: Pick<StayTimeCheckoutDependencies, "client">, id: string,
  work: (tx: Prisma.TransactionClient, m: Snapshot) => Promise<T>) {
  const locator = await deps.client.reservationModification.findUniqueOrThrow({ where: { id }, select: { reservationId: true } });
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.client.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${locator.reservationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "ReservationModification" WHERE "id" = ${id} FOR UPDATE`;
        const m = await tx.reservationModification.findUniqueOrThrow({ where: { id }, include: {
          reservation: { include: { property: { select: { name: true, organizationId: true } } } },
        } });
        if (m.reservationId !== locator.reservationId) reject("STAY_TIME_CHECKOUT_SCOPE_MISMATCH");
        assertScope(m);
        return work(tx, m);
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const conflict = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))));
      if (!conflict || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}
function journal(m: Snapshot): Journal {
  const value = m.failureDetails as unknown as Journal | null;
  if (m.failureCode !== "STAY_TIME_CHECKOUT_PREPARED" || value?.version !== "stay_time_checkout_v1" ||
      value.fingerprint !== m.requestFingerprint || !Number.isFinite(Date.parse(value.preparedAt)) || !value.presentation ||
      Object.values(value.presentation).some(v => typeof v !== "string") ||
      !["en", "es"].includes(value.presentation.preferredLanguage) ||
      typeof value.presentation.manageReservationUrl !== "string" || !m.stripeConnectedAccountId || !m.checkoutExpiresAt) {
    reject("STAY_TIME_CHECKOUT_JOURNAL_CONFLICT");
  }
  return value;
}
function contract(m: Snapshot, saved: Journal) {
  return buildGuestReservationModificationCheckoutSessionParams({ ...saved.presentation,
    modificationId: m.id, reservationId: m.reservationId, propertyId: m.reservation.propertyId,
    connectedAccountId: m.stripeConnectedAccountId!, currency: "usd", expiresAt: m.checkoutExpiresAt!,
    additionalChargeAmountCents: Math.round(Number(m.additionalChargeAmount) * 100),
    additionalPlatformFeeAmountCents: Math.round(Number(m.additionalPlatformFeeAmount) * 100),
    additionalHostPayoutAmountCents: Math.round(Number(m.additionalHostPayoutAmount) * 100),
  });
}
function assertSession(m: Snapshot, s: Stripe.Checkout.Session, account: string, livemode: boolean) {
  const metadata = {
    flow: "direct_booking_reservation_modification", stripeChargeMode: "DIRECT_CHARGE",
    reservationModificationId: m.id, reservationId: m.reservationId, propertyId: m.reservation.propertyId,
    connectedAccountId: account, additionalChargeAmountCents: String(Math.round(Number(m.additionalChargeAmount) * 100)),
    additionalPlatformFeeAmountCents: String(Math.round(Number(m.additionalPlatformFeeAmount) * 100)),
    additionalHostPayoutAmountCents: String(Math.round(Number(m.additionalHostPayoutAmount) * 100)),
  };
  if (!s.id?.startsWith("cs_") || s.object !== "checkout.session" || s.mode !== "payment" ||
      s.livemode !== livemode || m.stripeConnectedAccountId !== account ||
      (m.stripeCheckoutSessionId && m.stripeCheckoutSessionId !== s.id) ||
      s.client_reference_id !== m.id || s.currency !== "usd" ||
      s.amount_total !== Number(metadata.additionalChargeAmountCents) || !m.checkoutExpiresAt ||
      s.expires_at !== Math.floor(m.checkoutExpiresAt.getTime() / 1000) ||
      Object.entries(metadata).some(([key, value]) => s.metadata?.[key] !== value)) reject("STAY_TIME_CHECKOUT_SESSION_MISMATCH");
}
/** Persist the locator even if the reservation changed while Stripe responded.
 * A verified webhook can also repair a lost create response from the prepared
 * journal. Association is not proof of payment or authorization to apply. */
async function associate(deps: StayTimeCheckoutDependencies, id: string, session: Stripe.Checkout.Session, account: string) {
  return locked(deps, id, async (tx, m) => {
    assertSession(m, session, account, deps.livemode);
    return persistCheckoutAssociation(tx, m, session);
  });
}
async function persistCheckoutAssociation(tx: Prisma.TransactionClient, m: Snapshot, session: Stripe.Checkout.Session) {
  // Initialize only from a verified open Checkout. Never overwrite a webhook's
  // payment evidence or move a terminal/processing modification backwards.
  const initializeUnpaid = m.status === "AWAITING_PAYMENT" && m.stripePaymentStatus === null &&
    session.status === "open" && session.payment_status === "unpaid";
  if (m.stripeCheckoutSessionId && !initializeUnpaid) return m;
  if (!m.stripeCheckoutSessionId) journal(m);
  return tx.reservationModification.update({ where: { id: m.id }, data: {
    stripeCheckoutSessionId: session.id, ...(initializeUnpaid ? { stripePaymentStatus: "unpaid" } : {}),
  } });
}

/** Repair only a missing display status from an already-associated Checkout.
 * No create, confirm, expire, charge, or reservation application is permitted. */
export async function recoverStayTimeCheckoutStatus(input: { guestToken: string; modificationId: string },
  deps: Pick<StayTimeCheckoutDependencies, "client" | "now" | "stripe" | "livemode">): Promise<void> {
  const candidate = await locked(deps, input.modificationId, async (_tx, m) => {
    assertGuest(m, input.guestToken, deps.now());
    return m.status === "AWAITING_PAYMENT" && m.stripePaymentStatus === null &&
      m.stripeCheckoutSessionId && m.stripeConnectedAccountId && m.checkoutExpiresAt && m.checkoutExpiresAt > deps.now() ? m : null;
  });
  if (!candidate) return;
  const account = candidate.stripeConnectedAccountId!;
  const session = await deps.stripe.checkout.sessions.retrieve(candidate.stripeCheckoutSessionId!, {}, { stripeAccount: account });
  await locked(deps, input.modificationId, async (tx, current) => {
    assertGuest(current, input.guestToken, deps.now());
    assertSession(current, session, account, deps.livemode);
    if (current.checkoutExpiresAt! <= deps.now()) return;
    await persistCheckoutAssociation(tx, current, session);
  });
}
async function expireOpen(deps: StayTimeCheckoutDependencies, id: string, session: Stripe.Checkout.Session, account: string) {
  if (session.status !== "open") return;
  // Expiration can lose a race to payment. Re-read instead of interpreting the
  // provider exception as an expired, unpaid session; the webhook recovers paid.
  let current: Stripe.Checkout.Session;
  try { current = await deps.stripe.checkout.sessions.expire(session.id, {}, { stripeAccount: account }); }
  catch { current = await deps.stripe.checkout.sessions.retrieve(session.id, {}, { stripeAccount: account }); }
  await locked(deps, id, async (tx, m) => {
    assertSession(m, current, account, deps.livemode);
    if (current.status === "expired" && current.payment_status === "unpaid" && m.status === "AWAITING_PAYMENT") {
      await tx.reservationModification.update({ where: { id }, data: { status: "EXPIRED", expiredAt: deps.now() } });
    } else if (current.status === "open") reject("STAY_TIME_CHECKOUT_EXPIRATION_PENDING");
  });
}

/** Internal only: no live client, guest route, production webhook or worker is
 * installed here. Creation retries preserve the original account, deadline,
 * presentation and idempotency key. Provider I/O is outside database locks. */
export async function createStayTimeCheckout(input: { modificationId: string; guestToken: string }, deps: StayTimeCheckoutDependencies) {
  const initial = await locked(deps, input.modificationId, async (_tx, m) => {
    assertGuest(m, input.guestToken, deps.now());
    return m;
  });
  const payout = await deps.assertPayoutReady(initial.reservation.property.organizationId);
  const prepared = await locked(deps, input.modificationId, async (tx, m) => {
    assertGuest(m, input.guestToken, deps.now());
    if (!payout.connectedAccountId || payout.connectedAccountId !== m.reservation.stripeConnectedAccountId ||
        (m.stripeConnectedAccountId && m.stripeConnectedAccountId !== payout.connectedAccountId)) reject("STAY_TIME_CHECKOUT_ACCOUNT_CHANGED");
    if (m.stripeCheckoutSessionId) return { snapshot: m, saved: null };
    if (m.expiredAt || m.cancelledAt) reject("STAY_TIME_PAYMENT_ALREADY_CLOSED");
    await validatePaidStayTimeCheckout(tx, m, m.reservation, deps.now());
    if (m.failureDetails || m.failureCode) return { snapshot: m, saved: journal(m) };
    const base = new URL(deps.appUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) reject("STAY_TIME_CHECKOUT_CONFIG_INVALID");
    const language = await tx.pinAIActionProposal.findUniqueOrThrow({ where: { id: (m.guestConfirmation as { actionProposalId: string }).actionProposalId }, select: { language: true } });
    const saved: Journal = { version: "stay_time_checkout_v1", preparedAt: deps.now().toISOString(), fingerprint: m.requestFingerprint,
      presentation: { propertyName: m.reservation.property.name, guestEmail: m.reservation.guestEmail ?? "",
        preferredLanguage: language.language, manageReservationUrl: `${base.toString().replace(/\/+$/, "")}/booking/manage/${encodeURIComponent(input.guestToken)}` } };
    const snapshot = await tx.reservationModification.update({ where: { id: m.id }, data: {
      stripeConnectedAccountId: payout.connectedAccountId, failureCode: "STAY_TIME_CHECKOUT_PREPARED",
      failureDetails: saved as unknown as Prisma.InputJsonValue,
    }, include: { reservation: { include: { property: { select: { name: true, organizationId: true } } } } } });
    return { snapshot, saved };
  });
  const m = prepared.snapshot, account = m.stripeConnectedAccountId!;
  let session: Stripe.Checkout.Session;
  if (m.stripeCheckoutSessionId) {
    session = await deps.stripe.checkout.sessions.retrieve(m.stripeCheckoutSessionId, {}, { stripeAccount: account });
  } else {
    const built = contract(m, prepared.saved!);
    session = await deps.stripe.checkout.sessions.create(built.params, { ...built.requestOptions, idempotencyKey: built.idempotencyKey });
  }
  await associate(deps, m.id, session, account);
  if (session.status === "complete") return { outcome: "PAYMENT_PENDING" as const, actionExecuted: false as const, checkoutUrl: null };
  if (session.status === "expired") {
    await locked(deps, m.id, async (tx, current) => {
      if (current.status === "AWAITING_PAYMENT") await tx.reservationModification.update({ where: { id: m.id }, data: { status: "EXPIRED", expiredAt: deps.now() } });
    });
    reject("STAY_TIME_PAYMENT_WINDOW_EXPIRED");
  }
  try {
    if (session.status !== "open" || session.payment_status !== "unpaid" || !session.url) reject("STAY_TIME_CHECKOUT_SESSION_MISMATCH");
    const checkoutUrl = new URL(session.url);
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com" || checkoutUrl.username || checkoutUrl.password) reject("STAY_TIME_CHECKOUT_SESSION_MISMATCH");
    await locked(deps, m.id, async (tx, current) => {
      assertGuest(current, input.guestToken, deps.now());
      if (current.reservation.stripeConnectedAccountId !== account) reject("STAY_TIME_CHECKOUT_ACCOUNT_CHANGED");
      await validatePaidStayTimeCheckoutReplay(tx, current, current.reservation, deps.now());
    });
    return { outcome: "CHECKOUT_READY" as const, actionExecuted: false as const, checkoutUrl: session.url,
      checkoutSessionId: session.id, checkoutExpiresAt: m.checkoutExpiresAt, idempotentReplay: !!m.stripeCheckoutSessionId };
  } catch (error) {
    await expireOpen(deps, m.id, session, account);
    throw error;
  }
}

/** Callable adapter, deliberately NOT registered with the live webhook. Verify
 * raw bytes first, then retrieve in event.account; never fulfill a success URL
 * or trust payment fields in the event body. Stripe retries failures unchanged. */
export async function handleStayTimeStripeWebhook(input: { rawBody: Buffer; signature: string },
  deps: StayTimeCheckoutDependencies & { webhookSecret: string; payment: StayTimePaymentFlowDependencies }) {
  if (!deps.webhookSecret || !input.signature) reject("STAY_TIME_WEBHOOK_SIGNATURE_REQUIRED");
  const event = deps.stripe.webhooks.constructEvent(input.rawBody, input.signature, deps.webhookSecret);
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return { outcome: "IGNORED" as const };
  if (event.livemode !== deps.livemode || !event.account) reject("STAY_TIME_WEBHOOK_SCOPE_MISMATCH");
  const locator = event.data.object as Stripe.Checkout.Session;
  if (locator.metadata?.flow !== "direct_booking_reservation_modification") return { outcome: "IGNORED" as const };
  const id = locator.metadata.reservationModificationId;
  if (!id || !locator.id) reject("STAY_TIME_WEBHOOK_SCOPE_MISMATCH");
  const known = await deps.client.reservationModification.findUnique({ where: { id } });
  if (!known || !isStayTimeModification(known.guestConfirmation)) return { outcome: "IGNORED" as const };
  if (known.stripeConnectedAccountId !== event.account) reject("STAY_TIME_WEBHOOK_SCOPE_MISMATCH");
  const session = await deps.stripe.checkout.sessions.retrieve(locator.id, {}, { stripeAccount: event.account });
  if (session.id !== locator.id) reject("STAY_TIME_CHECKOUT_SESSION_MISMATCH");
  await associate(deps, id, session, event.account);
  if (session.status !== "complete" || session.payment_status !== "paid") return { outcome: "PAYMENT_PENDING" as const };
  if (deps.payment.client !== deps.client) reject("STAY_TIME_WEBHOOK_CONFIG_INVALID");
  return processStayTimePayment({ modificationId: id, checkoutSessionId: session.id, connectedAccountId: event.account }, deps.payment);
}
