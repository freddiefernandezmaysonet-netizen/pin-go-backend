import { createHash, randomUUID } from "node:crypto";
import {
  DamageCasePaymentAttemptStatus,
  DamageCaseStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import type Stripe from "stripe";
import {
  damagePaymentAuthorizationReservationInclude,
  evaluateRecordedDamagePaymentAuthorization,
} from "./damage-case-payment-authorization.service.js";

const EXECUTION_LEASE_MS = 5 * 60 * 1000;
const FLOW = "property_protection_damage_charge";

type StripePaymentIntentClient = {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: Stripe.RequestOptions
    ): Promise<Stripe.PaymentIntent>;
  };
};

export class DamageCasePaymentExecutionError extends Error {
  constructor(public code: string, public statusCode = 409) {
    super(code);
    this.name = "DamageCasePaymentExecutionError";
  }
}

const fail = (code: string, statusCode = 409): never => {
  throw new DamageCasePaymentExecutionError(code, statusCode);
};

function paymentIdempotencyKey(input: {
  organizationId: string;
  damageCaseId: string;
  authorizationId: string;
  claimRevision: string;
}) {
  const digest = createHash("sha256")
    .update(
      [
        "property-protection-charge-v1",
        input.organizationId,
        input.damageCaseId,
        input.authorizationId,
        input.claimRevision,
      ].join(":"),
      "utf8"
    )
    .digest("hex");
  return `pingo_pp_charge_v1_${digest}`;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return typeof (value as { id?: unknown }).id === "string"
      ? String((value as { id: string }).id)
      : null;
  }
  return null;
}

function safeText(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function paymentIntentFromError(error: unknown): Stripe.PaymentIntent | null {
  if (!error || typeof error !== "object") return null;
  const candidate =
    (error as { payment_intent?: unknown }).payment_intent ??
    (error as { raw?: { payment_intent?: unknown } }).raw?.payment_intent;
  return candidate && typeof candidate === "object" && "id" in candidate
    ? (candidate as Stripe.PaymentIntent)
    : null;
}

function failureFrom(error: unknown, paymentIntent?: Stripe.PaymentIntent | null) {
  const source = error && typeof error === "object" ? error as Record<string, any> : {};
  return {
    failureCode: safeText(
      source.code ?? paymentIntent?.last_payment_error?.code ?? "STRIPE_PAYMENT_FAILED",
      120
    ),
    declineCode: safeText(
      source.decline_code ?? paymentIntent?.last_payment_error?.decline_code,
      120
    ),
    failureMessage: safeText(
      source.message ?? paymentIntent?.last_payment_error?.message ?? "Stripe could not complete the payment."
    ),
  };
}

export function damageCasePaymentAttemptStatusFromPaymentIntent(
  paymentIntent: Stripe.PaymentIntent
) {
  switch (paymentIntent.status) {
    case "succeeded":
      return DamageCasePaymentAttemptStatus.SUCCEEDED;
    case "requires_action":
    case "requires_confirmation":
      return DamageCasePaymentAttemptStatus.REQUIRES_ACTION;
    case "canceled":
      return DamageCasePaymentAttemptStatus.CANCELED;
    case "requires_payment_method":
      return DamageCasePaymentAttemptStatus.FAILED;
    default:
      return DamageCasePaymentAttemptStatus.PROCESSING;
  }
}

export function buildDamagePaymentIntentRequest(input: {
  amountMinor: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  connectedAccountId: string;
  idempotencyKey: string;
  organizationId: string;
  reservationId: string;
  reservationNumber: string | null;
  damageCaseId: string;
  paymentAuthorizationId: string;
  claimRevision: string;
}) {
  return {
    params: {
      amount: input.amountMinor,
      currency: input.currency,
      customer: input.customerId,
      payment_method: input.paymentMethodId,
      off_session: true,
      confirm: true,
      description: input.reservationNumber
        ? `Property Protection ${input.reservationNumber}`
        : "Property Protection damage case",
      metadata: {
        flow: FLOW,
        organizationId: input.organizationId,
        reservationId: input.reservationId,
        damageCaseId: input.damageCaseId,
        paymentAuthorizationId: input.paymentAuthorizationId,
        claimRevision: input.claimRevision,
      },
    } satisfies Stripe.PaymentIntentCreateParams,
    options: {
      stripeAccount: input.connectedAccountId,
      idempotencyKey: input.idempotencyKey,
    } satisfies Stripe.RequestOptions,
  };
}

async function prepareAndClaim(input: {
  prisma: PrismaClient;
  organizationId: string;
  damageCaseId: string;
  requestedByUserId: string;
  now: Date;
}) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      return await input.prisma.$transaction(async (db) => {
        const cases = await db.$queryRaw<Array<{ reservationId: string }>>`
          SELECT "reservationId" FROM "DamageCase" WHERE "id" = ${input.damageCaseId} FOR UPDATE`;
        if (!cases.length) return fail("DAMAGE_CASE_NOT_FOUND", 404);
        await db.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${cases[0].reservationId} FOR UPDATE`;

        const reservation = await db.reservation.findFirst({
          where: {
            id: cases[0].reservationId,
            property: { organizationId: input.organizationId },
          },
          include: damagePaymentAuthorizationReservationInclude,
        });
        if (!reservation?.damageCase || reservation.damageCase.id !== input.damageCaseId)
          return fail("DAMAGE_CASE_NOT_FOUND", 404);

        const priorAttempt = reservation.damageCase.paymentAttempt;
        if (priorAttempt?.status === DamageCasePaymentAttemptStatus.SUCCEEDED)
          return { kind: "SUCCEEDED" as const, attempt: priorAttempt };

        const evaluated = evaluateRecordedDamagePaymentAuthorization(
          reservation,
          input.now
        );
        if (!evaluated.eligibility.eligible)
          return fail(evaluated.eligibility.reason);

        const damageCase = reservation.damageCase;
        const authorization = damageCase.paymentAuthorization!;
        const expectedKey = paymentIdempotencyKey({
          organizationId: input.organizationId,
          damageCaseId: damageCase.id,
          authorizationId: authorization.id,
          claimRevision: evaluated.publicTerms.claimRevision,
        });
        const existing = priorAttempt;

        if (existing) {
          if (
            existing.paymentAuthorizationId !== authorization.id ||
            existing.organizationId !== input.organizationId ||
            existing.reservationId !== reservation.id ||
            existing.connectedAccountId !== authorization.connectedAccountId ||
            existing.claimRevision !== authorization.claimRevision ||
            existing.amountMinor !== authorization.amountMinor ||
            existing.currency !== authorization.currency ||
            existing.idempotencyKey !== expectedKey
          ) return fail("PAYMENT_ATTEMPT_SCOPE_MISMATCH");

          if (existing.status === DamageCasePaymentAttemptStatus.REQUIRES_ACTION)
            return fail("PAYMENT_REQUIRES_GUEST_ACTION", 409);
          if (existing.status === DamageCasePaymentAttemptStatus.FAILED)
            return fail("PAYMENT_ATTEMPT_FAILED", 409);
          if (existing.status === DamageCasePaymentAttemptStatus.CANCELED)
            return fail("PAYMENT_ATTEMPT_CANCELED", 409);
          if (
            existing.status === DamageCasePaymentAttemptStatus.PROCESSING &&
            existing.executionLeaseExpiresAt &&
            existing.executionLeaseExpiresAt > input.now
          ) return { kind: "IN_PROGRESS" as const, attempt: existing };
        }

        const attempt = existing ?? await db.damageCasePaymentAttempt.create({
          data: {
            damageCaseId: damageCase.id,
            paymentAuthorizationId: authorization.id,
            organizationId: input.organizationId,
            reservationId: reservation.id,
            connectedAccountId: authorization.connectedAccountId,
            claimRevision: authorization.claimRevision,
            amountMinor: authorization.amountMinor,
            currency: authorization.currency,
            idempotencyKey: expectedKey,
            requestedByUserId: input.requestedByUserId,
          },
        });

        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(input.now.getTime() + EXECUTION_LEASE_MS);
        const claimed = await db.damageCasePaymentAttempt.updateMany({
          where: {
            id: attempt.id,
            OR: [
              { status: DamageCasePaymentAttemptStatus.PREPARED },
              {
                status: DamageCasePaymentAttemptStatus.PROCESSING,
                executionLeaseExpiresAt: { lte: input.now },
              },
              {
                status: DamageCasePaymentAttemptStatus.PROCESSING,
                executionLeaseExpiresAt: null,
              },
            ],
          },
          data: {
            status: DamageCasePaymentAttemptStatus.PROCESSING,
            executionLeaseId: leaseId,
            executionLeaseExpiresAt: leaseExpiresAt,
            attemptCount: { increment: 1 },
            firstAttemptedAt: attempt.firstAttemptedAt ?? input.now,
            lastAttemptedAt: input.now,
          },
        });
        if (claimed.count !== 1)
          return { kind: "IN_PROGRESS" as const, attempt };

        return {
          kind: "CLAIMED" as const,
          attempt: { ...attempt, executionLeaseId: leaseId },
          reservationNumber: reservation.reservationNumber,
          customerId: reservation.stripeDamageCustomerId!,
          paymentMethodId: reservation.stripeDamagePaymentMethodId!,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (["P2034", "P2002"].includes(error.code) ||
          (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))
      ) {
        if (retry < 2) continue;
        return fail("PAYMENT_ATTEMPT_CONCURRENT_CHANGE");
      }
      throw error;
    }
  }
  return fail("PAYMENT_ATTEMPT_CONCURRENT_CHANGE");
}

async function persistPaymentIntent(input: {
  prisma: PrismaClient;
  attemptId: string;
  leaseId: string;
  paymentIntent: Stripe.PaymentIntent;
  now: Date;
  failure?: ReturnType<typeof failureFrom>;
}) {
  const status = damageCasePaymentAttemptStatusFromPaymentIntent(
    input.paymentIntent
  );
  return input.prisma.$transaction(async (db) => {
    const updated = await db.damageCasePaymentAttempt.updateMany({
      where: {
        id: input.attemptId,
        executionLeaseId: input.leaseId,
        status: { not: DamageCasePaymentAttemptStatus.SUCCEEDED },
      },
      data: {
        status,
        stripePaymentIntentId: input.paymentIntent.id,
        stripeChargeId: objectId(input.paymentIntent.latest_charge),
        providerStatus: input.paymentIntent.status,
        failureCode: input.failure?.failureCode ?? null,
        declineCode: input.failure?.declineCode ?? null,
        failureMessage: input.failure?.failureMessage ?? null,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        succeededAt:
          status === DamageCasePaymentAttemptStatus.SUCCEEDED ? input.now : null,
        failedAt:
          status === DamageCasePaymentAttemptStatus.FAILED ||
          status === DamageCasePaymentAttemptStatus.CANCELED
            ? input.now
            : null,
      },
    });
    if (updated.count !== 1) return fail("PAYMENT_ATTEMPT_LEASE_LOST", 409);

    const attempt = await db.damageCasePaymentAttempt.findUniqueOrThrow({
      where: { id: input.attemptId },
    });
    if (status === DamageCasePaymentAttemptStatus.SUCCEEDED) {
      const advanced = await db.damageCase.updateMany({
        where: {
          id: attempt.damageCaseId,
          status: DamageCaseStatus.GUEST_NOTIFIED,
        },
        data: { status: DamageCaseStatus.CHARGED },
      });
      if (advanced.count !== 1) {
        const damageCase = await db.damageCase.findUniqueOrThrow({
          where: { id: attempt.damageCaseId },
          select: { status: true },
        });
        if (damageCase.status !== DamageCaseStatus.CHARGED)
          return fail("PAYMENT_SUCCEEDED_CASE_RECONCILIATION_REQUIRED", 500);
      }
    }
    return attempt;
  });
}

export async function executeDamageCasePayment(input: {
  prisma: PrismaClient;
  stripeClient: StripePaymentIntentClient;
  organizationId: string;
  damageCaseId: string;
  requestedByUserId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claim = await prepareAndClaim({ ...input, now });
  if (claim.kind === "SUCCEEDED")
    return { ok: true, idempotent: true, paymentAttempt: claim.attempt };
  if (claim.kind === "IN_PROGRESS")
    return { ok: true, inProgress: true, paymentAttempt: claim.attempt };

  const request = buildDamagePaymentIntentRequest({
    amountMinor: claim.attempt.amountMinor,
    currency: claim.attempt.currency,
    customerId: claim.customerId,
    paymentMethodId: claim.paymentMethodId,
    connectedAccountId: claim.attempt.connectedAccountId,
    idempotencyKey: claim.attempt.idempotencyKey,
    organizationId: claim.attempt.organizationId,
    reservationId: claim.attempt.reservationId,
    reservationNumber: claim.reservationNumber,
    damageCaseId: claim.attempt.damageCaseId,
    paymentAuthorizationId: claim.attempt.paymentAuthorizationId,
    claimRevision: claim.attempt.claimRevision,
  });

  try {
    const paymentIntent = await input.stripeClient.paymentIntents.create(
      request.params,
      request.options
    );
    const paymentAttempt = await persistPaymentIntent({
      prisma: input.prisma,
      attemptId: claim.attempt.id,
      leaseId: claim.attempt.executionLeaseId!,
      paymentIntent,
      now: new Date(),
      failure:
        paymentIntent.status === "requires_payment_method" ||
        paymentIntent.status === "canceled"
          ? failureFrom(null, paymentIntent)
          : undefined,
    });
    return {
      ok: paymentAttempt.status === DamageCasePaymentAttemptStatus.SUCCEEDED,
      inProgress: paymentAttempt.status === DamageCasePaymentAttemptStatus.PROCESSING,
      requiresAction:
        paymentAttempt.status === DamageCasePaymentAttemptStatus.REQUIRES_ACTION,
      paymentAttempt,
    };
  } catch (error) {
    const paymentIntent = paymentIntentFromError(error);
    if (!paymentIntent) {
      // The request result is uncertain. Keep the bounded lease and reuse the
      // same Stripe idempotency key after it expires instead of risking a duplicate.
      throw new DamageCasePaymentExecutionError("PAYMENT_PROVIDER_RESULT_UNCERTAIN", 503);
    }
    const paymentAttempt = await persistPaymentIntent({
      prisma: input.prisma,
      attemptId: claim.attempt.id,
      leaseId: claim.attempt.executionLeaseId!,
      paymentIntent,
      now: new Date(),
      failure: failureFrom(error, paymentIntent),
    });
    return {
      ok: false,
      requiresAction:
        paymentAttempt.status === DamageCasePaymentAttemptStatus.REQUIRES_ACTION,
      paymentAttempt,
    };
  }
}

export const damageCasePaymentFlow = FLOW;
