import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { reviewAutoPublishEnabled } from "../../config/reviews.config.js";
import { prisma } from "../../lib/prisma.js";
import {
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_INVITATION_TTL_DAYS,
  REVIEW_RESPONSE_MAX_LENGTH,
  ReviewPolicyError,
  detectSafetySignals,
  guestDisplayName,
  initialReviewDecision,
  normalizeReviewDeliveryError,
  normalizeReviewText,
  parseRatings,
  parseModerationReason,
  parsePositiveInteger,
  parsePublicReviewSort,
  assertModerationTransition,
  assertResponseModerationTransition,
  requireModerationEvidence,
  requireResponseModerationDecision,
  type ModerationActionValue,
  type ResponseModerationActionValue,
  type ReviewStatusValue,
} from "./review-policy.js";
import { assertReviewStayEligible } from "./review-eligibility.policy.js";
import { decryptReviewToken, encryptReviewToken } from "./review-token-crypto.service.js";
import { assertEvidenceReference, buildReviewModerationDecisionEvidence, buildReviewModerationEvidence } from "./review-moderation-evidence.service.js";

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const recipientEmailHash = (email: string) => tokenHash(email.trim().toLowerCase());

export type ReviewInvitationDeliveryFence = {
  tokenHash: string;
  recipientEmailHash: string;
  recipientEmail: string;
};

export function reviewInvitationExpiresAt(checkOut: Date): Date {
  return new Date(checkOut.getTime() + REVIEW_INVITATION_TTL_DAYS * 86_400_000);
}

async function readActiveInvitationAfterCas(input: {
  reservationId: string;
  recipientEmailHash: string;
  guestEmail: string;
  language: string;
  propertyName: string;
}, client: PrismaClient = prisma) {
  const persisted = await client.propertyReviewInvitation.findUnique({
    where: { reservationId: input.reservationId },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      status: true,
      deliveryStatus: true,
      consumedAt: true,
      tokenHash: true,
      tokenCiphertext: true,
      recipientEmailHash: true,
    },
  });
  if (!persisted) throw new ReviewPolicyError("REVIEW_INVITATION_CONFLICT", "The review invitation changed. Retry the request.", 409);
  if (persisted.status === "REVOKED") throw new ReviewPolicyError("REVIEW_INVITATION_REVOKED", "This review invitation was revoked.", 410);
  if (persisted.consumedAt || persisted.status === "CONSUMED") throw new ReviewPolicyError("REVIEW_INVITATION_CONSUMED", "This invitation was already used.", 409);
  if (persisted.status !== "INVITED" || persisted.recipientEmailHash !== input.recipientEmailHash) {
    throw new ReviewPolicyError("REVIEW_INVITATION_CONFLICT", "The review invitation changed. Retry the request.", 409);
  }

  const token = decryptReviewToken(persisted.tokenCiphertext);
  if (tokenHash(token) !== persisted.tokenHash) {
    throw new ReviewPolicyError("REVIEW_INVITATION_TOKEN_INVALID", "The stored review invitation token is invalid.", 500);
  }
  const { tokenHash: _tokenHash, tokenCiphertext: _tokenCiphertext, recipientEmailHash: _recipientEmailHash, consumedAt: _consumedAt, ...invitation } = persisted;
  return {
    token,
    invitation,
    deliveryFence: {
      tokenHash: persisted.tokenHash,
      recipientEmailHash: persisted.recipientEmailHash,
      recipientEmail: input.guestEmail,
    },
    guestEmail: input.guestEmail,
    language: input.language,
    propertyName: input.propertyName,
  };
}

export async function syncReviewInvitationExpiry(
  input: { reservationId: string; checkOut: Date; now?: Date },
  client: Pick<Prisma.TransactionClient, "propertyReviewInvitation"> = prisma,
) {
  const invitation = await client.propertyReviewInvitation.findUnique({
    where: { reservationId: input.reservationId },
    select: { id: true, createdAt: true, consumedAt: true, status: true, expiresAt: true },
  });
  if (
    !invitation ||
    invitation.consumedAt ||
    invitation.status === "CONSUMED"
  ) {
    return null;
  }

  // An expired or revoked generation stays closed. A checkout extension may
  // make the stay eligible again, but reopening the old bearer token would be
  // unsafe; createReviewInvitation rotates it explicitly instead.
  if (["EXPIRED", "REVOKED"].includes(invitation.status)) {
    return invitation;
  }

  const now = input.now ?? new Date();
  const canonicalExpiresAt = reviewInvitationExpiresAt(input.checkOut);
  const persistedExpiresAt = canonicalExpiresAt > invitation.createdAt
    ? canonicalExpiresAt
    : new Date(invitation.createdAt.getTime() + 1);
  const shouldExpire = canonicalExpiresAt <= now && !["EXPIRED", "REVOKED"].includes(invitation.status);
  if (!shouldExpire && invitation.expiresAt.getTime() === persistedExpiresAt.getTime()) return invitation;

  return client.propertyReviewInvitation.update({
    where: { id: invitation.id },
    data: {
      expiresAt: persistedExpiresAt,
      ...(shouldExpire ? { status: "EXPIRED" as const } : {}),
    },
  });
}

export async function createReviewInvitation(
  reservationId: string,
  now = new Date(),
  client: PrismaClient = prisma
) {
  const reservation = await client.reservation.findUnique({
    where: { id: reservationId },
    include: { property: { select: { id: true, organizationId: true, name: true, publicTitle: true } }, review: true, reviewInvitation: true },
  });
  if (!reservation) throw new ReviewPolicyError("REVIEW_RESERVATION_NOT_FOUND", "Reservation not found.", 404);
  assertReviewStayEligible(reservation, { requireCheckoutCompleted: false, now });
  if (!reservation.guestEmail) throw new ReviewPolicyError("REVIEW_GUEST_EMAIL_REQUIRED", "The reservation has no guest email.", 409);
  if (reservation.review) throw new ReviewPolicyError("REVIEW_ALREADY_SUBMITTED", "This stay already has a review.", 409);
  if (reservation.reviewInvitation?.consumedAt) throw new ReviewPolicyError("REVIEW_INVITATION_CONSUMED", "This invitation was already used.", 409);
  if (reservation.reviewInvitation?.status === "REVOKED") throw new ReviewPolicyError("REVIEW_INVITATION_REVOKED", "This review invitation was revoked.", 410);

  const expiresAt = reviewInvitationExpiresAt(reservation.checkOut);
  const currentRecipientEmailHash = recipientEmailHash(reservation.guestEmail);
  if (expiresAt <= now) throw new ReviewPolicyError("REVIEW_INVITATION_EXPIRED", "The review window has expired.", 410);
  if (reservation.reviewInvitation) {
    if (
      reservation.reviewInvitation.recipientEmailHash !== currentRecipientEmailHash ||
      reservation.reviewInvitation.status === "EXPIRED"
    ) {
      const replacementToken = crypto.randomBytes(32).toString("base64url");
      await client.propertyReviewInvitation.updateMany({
        where: {
          id: reservation.reviewInvitation.id,
          tokenHash: reservation.reviewInvitation.tokenHash,
          recipientEmailHash: reservation.reviewInvitation.recipientEmailHash,
          status: reservation.reviewInvitation.status,
          consumedAt: null,
        },
        data: {
          tokenHash: tokenHash(replacementToken),
          tokenCiphertext: encryptReviewToken(replacementToken),
          recipientEmailHash: currentRecipientEmailHash,
          status: "INVITED",
          expiresAt,
          invitedAt: now,
          deliveryStatus: "PENDING",
          deliveryAttemptCount: 0,
          lastDeliveryAttemptAt: null,
          providerAcceptedAt: null,
          deliveryProviderMessageId: null,
          lastDeliveryError: null,
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
        },
      });
      // Both the CAS winner and loser re-read the persisted row. Consequently,
      // concurrent reconciliation callers return the single token that won the
      // rotation instead of leaking two different candidate tokens.
      return readActiveInvitationAfterCas({
        reservationId,
        recipientEmailHash: currentRecipientEmailHash,
        guestEmail: reservation.guestEmail,
        language: reservation.preferredLanguage,
        propertyName: reservation.property.publicTitle ?? reservation.property.name,
      }, client);
    }
    if (reservation.reviewInvitation.expiresAt.getTime() !== expiresAt.getTime() || reservation.reviewInvitation.status !== "INVITED") {
      await client.propertyReviewInvitation.updateMany({
        where: {
          id: reservation.reviewInvitation.id,
          tokenHash: reservation.reviewInvitation.tokenHash,
          recipientEmailHash: currentRecipientEmailHash,
          status: reservation.reviewInvitation.status,
          consumedAt: null,
        },
        data: { expiresAt, status: "INVITED", invitedAt: reservation.reviewInvitation.invitedAt ?? now },
      });
    }
    return readActiveInvitationAfterCas({
      reservationId,
      recipientEmailHash: currentRecipientEmailHash,
      guestEmail: reservation.guestEmail,
      language: reservation.preferredLanguage,
      propertyName: reservation.property.publicTitle ?? reservation.property.name,
    }, client);
  }

  const rawToken = crypto.randomBytes(32).toString("base64url");
  try {
    const invitation = await client.propertyReviewInvitation.create({
      data: { reservationId, propertyId: reservation.propertyId, organizationId: reservation.property.organizationId, tokenHash: tokenHash(rawToken), tokenCiphertext: encryptReviewToken(rawToken), recipientEmailHash: currentRecipientEmailHash, status: "INVITED", invitedAt: now, deliveryStatus: "PENDING", expiresAt },
      select: { id: true, createdAt: true, expiresAt: true, status: true, deliveryStatus: true },
    });
    return {
      token: rawToken,
      invitation,
      deliveryFence: {
        tokenHash: tokenHash(rawToken),
        recipientEmailHash: currentRecipientEmailHash,
        recipientEmail: reservation.guestEmail,
      },
      guestEmail: reservation.guestEmail,
      language: reservation.preferredLanguage,
      propertyName:
        reservation.property.publicTitle ?? reservation.property.name,
    };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return readActiveInvitationAfterCas({
      reservationId,
      recipientEmailHash: currentRecipientEmailHash,
      guestEmail: reservation.guestEmail,
      language: reservation.preferredLanguage,
      propertyName: reservation.property.publicTitle ?? reservation.property.name,
    }, client);
  }
}

export async function assertReviewInvitationDeliveryFence(
  input: {
    invitationId: string;
    deliveryFence: ReviewInvitationDeliveryFence;
    to: string;
    now?: Date;
  },
  client: PrismaClient = prisma
) {
  const now = input.now ?? new Date();
  const invitation = await client.propertyReviewInvitation.findUnique({
    where: { id: input.invitationId },
    select: {
      tokenHash: true,
      recipientEmailHash: true,
      status: true,
      consumedAt: true,
      expiresAt: true,
      reservation: {
        select: { guestEmail: true },
      },
    },
  });

  if (
    !invitation ||
    invitation.tokenHash !== input.deliveryFence.tokenHash ||
    invitation.recipientEmailHash !==
      input.deliveryFence.recipientEmailHash ||
    invitation.consumedAt ||
    !["ELIGIBLE", "INVITED"].includes(invitation.status)
  ) {
    throw new ReviewPolicyError(
      "REVIEW_INVITATION_DELIVERY_GENERATION_CHANGED",
      "The review invitation changed before delivery.",
      409
    );
  }

  if (invitation.expiresAt <= now) {
    throw new ReviewPolicyError(
      "REVIEW_INVITATION_EXPIRED",
      "The review invitation expired before delivery.",
      410
    );
  }

  const canonicalRecipient = String(
    invitation.reservation.guestEmail ?? ""
  )
    .trim()
    .toLowerCase();
  const requestedRecipient = String(input.to ?? "")
    .trim()
    .toLowerCase();
  const fencedRecipient = String(
    input.deliveryFence.recipientEmail ?? ""
  )
    .trim()
    .toLowerCase();
  if (
    !canonicalRecipient ||
    requestedRecipient !== canonicalRecipient ||
    fencedRecipient !== canonicalRecipient ||
    recipientEmailHash(canonicalRecipient) !==
      invitation.recipientEmailHash
  ) {
    throw new ReviewPolicyError(
      "REVIEW_INVITATION_RECIPIENT_CHANGED",
      "The review invitation recipient changed before delivery.",
      409
    );
  }

  return { recipient: canonicalRecipient };
}

export async function markReviewInvitationDelivery(
  input: {
    invitationId: string;
    deliveryFence: ReviewInvitationDeliveryFence;
    delivered: boolean;
    providerMessageId?: string | null;
    error?: string | null;
    now?: Date;
    providerAcceptedAt?: Date;
    recordProviderAttempt?: boolean;
  },
  client: PrismaClient = prisma
) {
  const now = input.now ?? new Date();
  const recordProviderAttempt = input.recordProviderAttempt !== false;
  if (
    input.delivered &&
    !recordProviderAttempt &&
    !input.providerAcceptedAt
  ) {
    throw new ReviewPolicyError(
      "REVIEW_INVITATION_ACCEPTANCE_EVIDENCE_REQUIRED",
      "Reconciliation requires the original provider acceptance time.",
      400
    );
  }
  const providerAcceptedAt = input.providerAcceptedAt ?? now;
  if (Number.isNaN(providerAcceptedAt.getTime())) {
    throw new ReviewPolicyError(
      "REVIEW_INVITATION_DELIVERY_TIME_INVALID",
      "The review delivery acceptance time is invalid.",
      400
    );
  }
  if (input.delivered) {
    const invitation = await client.propertyReviewInvitation.findUnique({
      where: { id: input.invitationId },
      select: {
        tokenHash: true,
        recipientEmailHash: true,
        status: true,
        deliveryStatus: true,
        consumedAt: true,
        reservation: {
          select: { guestEmail: true },
        },
      },
    });
    if (
      !invitation ||
      invitation.tokenHash !== input.deliveryFence.tokenHash ||
      invitation.recipientEmailHash !==
        input.deliveryFence.recipientEmailHash ||
      String(invitation.reservation.guestEmail ?? "")
        .trim()
        .toLowerCase() !==
        String(input.deliveryFence.recipientEmail ?? "")
          .trim()
          .toLowerCase() ||
      invitation.consumedAt ||
      !["ELIGIBLE", "INVITED"].includes(invitation.status)
    ) {
      return { count: 0 };
    }

    if (invitation.deliveryStatus === "SENT") {
      // Idempotent provider replays keep the first accepted timestamp intact.
      if (!recordProviderAttempt && !input.providerMessageId) {
        return { count: 1 };
      }
      return client.propertyReviewInvitation.updateMany({
        where: {
          id: input.invitationId,
          tokenHash: input.deliveryFence.tokenHash,
          recipientEmailHash: input.deliveryFence.recipientEmailHash,
          reservation: {
            guestEmail: input.deliveryFence.recipientEmail,
          },
          consumedAt: null,
          status: "INVITED",
          deliveryStatus: "SENT",
        },
        data: {
          ...(recordProviderAttempt
            ? {
                lastDeliveryAttemptAt: now,
                deliveryAttemptCount: { increment: 1 },
              }
            : {}),
          deliveryProviderMessageId:
            input.providerMessageId ?? undefined,
          lastDeliveryError: null,
        },
      });
    }

    const firstAcceptance = await client.propertyReviewInvitation.updateMany({
      where: {
        id: input.invitationId,
        tokenHash: input.deliveryFence.tokenHash,
        recipientEmailHash: input.deliveryFence.recipientEmailHash,
        reservation: {
          guestEmail: input.deliveryFence.recipientEmail,
        },
        consumedAt: null,
        status: invitation.status,
        deliveryStatus: { not: "SENT" },
      },
      data: {
        status: "INVITED",
        deliveryStatus: "SENT",
        ...(invitation.status === "ELIGIBLE"
          ? {
              invitedAt: recordProviderAttempt
                ? now
                : providerAcceptedAt,
            }
          : {}),
        providerAcceptedAt,
        lastDeliveryAttemptAt: recordProviderAttempt
          ? now
          : providerAcceptedAt,
        deliveryAttemptCount: { increment: 1 },
        deliveryProviderMessageId: input.providerMessageId ?? null,
        lastDeliveryError: null,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
      },
    });
    if (firstAcceptance.count === 1) return firstAcceptance;

    // A concurrent success may have won the transition; record this provider
    // result without replacing the first acceptance timestamp.
    return client.propertyReviewInvitation.updateMany({
      where: {
        id: input.invitationId,
        tokenHash: input.deliveryFence.tokenHash,
        recipientEmailHash: input.deliveryFence.recipientEmailHash,
        reservation: {
          guestEmail: input.deliveryFence.recipientEmail,
        },
        consumedAt: null,
        status: "INVITED",
        deliveryStatus: "SENT",
      },
      data: {
        ...(recordProviderAttempt
          ? {
              lastDeliveryAttemptAt: now,
              deliveryAttemptCount: { increment: 1 },
            }
          : {}),
        deliveryProviderMessageId:
          input.providerMessageId ?? undefined,
        lastDeliveryError: null,
      },
    });
  }

  const lastDeliveryError = normalizeReviewDeliveryError(input.error);
  if (!recordProviderAttempt) {
    return client.$transaction([
      client.propertyReviewInvitation.updateMany({
        where: {
          id: input.invitationId,
          tokenHash: input.deliveryFence.tokenHash,
          recipientEmailHash: input.deliveryFence.recipientEmailHash,
          reservation: {
            guestEmail: input.deliveryFence.recipientEmail,
          },
          consumedAt: null,
          status: { in: ["ELIGIBLE", "INVITED"] },
          deliveryStatus: { not: "SENT" },
        },
        data: {
          deliveryStatus: "PENDING",
          providerAcceptedAt: null,
          lastDeliveryError,
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
        },
      }),
      client.propertyReviewInvitation.updateMany({
        where: {
          id: input.invitationId,
          tokenHash: input.deliveryFence.tokenHash,
          recipientEmailHash: input.deliveryFence.recipientEmailHash,
          reservation: {
            guestEmail: input.deliveryFence.recipientEmail,
          },
          consumedAt: null,
          status: "INVITED",
          deliveryStatus: "SENT",
        },
        data: { lastDeliveryError },
      }),
    ]);
  }

  return client.$transaction([
    client.propertyReviewInvitation.updateMany({
      where: {
        id: input.invitationId,
        tokenHash: input.deliveryFence.tokenHash,
        recipientEmailHash: input.deliveryFence.recipientEmailHash,
        reservation: {
          guestEmail: input.deliveryFence.recipientEmail,
        },
        consumedAt: null,
        status: { in: ["ELIGIBLE", "INVITED"] },
        deliveryStatus: { not: "SENT" },
      },
      data: {
        deliveryStatus: "FAILED",
        providerAcceptedAt: null,
        ...(recordProviderAttempt
          ? {
              lastDeliveryAttemptAt: now,
              deliveryAttemptCount: { increment: 1 },
            }
          : {}),
        lastDeliveryError,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
      },
    }),
    // A failed resend must not revoke an invitation that was delivered earlier.
    client.propertyReviewInvitation.updateMany({
      where: {
        id: input.invitationId,
        tokenHash: input.deliveryFence.tokenHash,
        recipientEmailHash: input.deliveryFence.recipientEmailHash,
        reservation: {
          guestEmail: input.deliveryFence.recipientEmail,
        },
        consumedAt: null,
        status: "INVITED",
        deliveryStatus: "SENT",
      },
      data: {
        ...(recordProviderAttempt
          ? {
              lastDeliveryAttemptAt: now,
              deliveryAttemptCount: { increment: 1 },
            }
          : {}),
        lastDeliveryError,
      },
    }),
  ]);
}

export async function getReviewInvitation(rawToken: string, now = new Date()) {
  if (!rawToken || rawToken.length < 32) throw new ReviewPolicyError("REVIEW_TOKEN_INVALID", "Review link is invalid.", 404);
  const invitation = await prisma.propertyReviewInvitation.findUnique({
    where: { tokenHash: tokenHash(rawToken) },
    include: { reservation: { select: { guestName: true, guestEmail: true, checkIn: true, checkOut: true, preferredLanguage: true, status: true, cancelledAt: true, source: true, externalProvider: true, paymentState: true, amountCollected: true } }, property: { select: { name: true, publicTitle: true, publicPhotos: true } } },
  });
  if (!invitation) throw new ReviewPolicyError("REVIEW_TOKEN_INVALID", "Review link is invalid.", 404);
  if (invitation.consumedAt || invitation.status === "CONSUMED") throw new ReviewPolicyError("REVIEW_TOKEN_CONSUMED", "This review was already submitted.", 410);
  if (!invitation.reservation.guestEmail || invitation.recipientEmailHash !== recipientEmailHash(invitation.reservation.guestEmail)) throw new ReviewPolicyError("REVIEW_TOKEN_RECIPIENT_CHANGED", "Review link is no longer assigned to the current guest.", 410);
  const expiresAt = reviewInvitationExpiresAt(invitation.reservation.checkOut);
  if (expiresAt <= now || invitation.status === "EXPIRED" || invitation.status === "REVOKED") throw new ReviewPolicyError("REVIEW_TOKEN_EXPIRED", "Review link has expired.", 410);
  assertReviewStayEligible(invitation.reservation, { requireCheckoutCompleted: false, now });
  return {
    propertyName: invitation.property.publicTitle ?? invitation.property.name,
    propertyPhoto: Array.isArray(invitation.property.publicPhotos) ? String(invitation.property.publicPhotos[0] ?? "") : "",
    checkIn: invitation.reservation.checkIn,
    checkOut: invitation.reservation.checkOut,
    language: invitation.reservation.preferredLanguage,
    availableAt: invitation.reservation.checkOut,
    expiresAt,
    canSubmit: invitation.reservation.checkOut <= now && invitation.status === "INVITED",
  };
}

export async function submitReview(rawToken: string, input: unknown, now = new Date()) {
  const ratings = parseRatings(input);
  const record = (input ?? {}) as Record<string, unknown>;
  const publicComment = normalizeReviewText(record.publicComment, "publicComment", REVIEW_COMMENT_MAX_LENGTH, true)!;
  const privateFeedback = normalizeReviewText(record.privateFeedback, "privateFeedback", REVIEW_COMMENT_MAX_LENGTH);
  const language = typeof record.language === "string" && /^(en|es)(-[A-Z]{2})?$/i.test(record.language) ? record.language.slice(0, 10) : "en";
  const hash = tokenHash(rawToken);

  return prisma.$transaction(async (tx) => {
    // Resolve only the reservation identity before taking the lock. All
    // authorization-relevant reservation fields are re-read after PostgreSQL
    // serializes us against guest/date/cancellation updates on this row.
    const invitationIdentity = await tx.propertyReviewInvitation.findUnique({
      where: { tokenHash: hash },
      select: { reservationId: true },
    });
    if (!invitationIdentity) throw new ReviewPolicyError("REVIEW_TOKEN_INVALID", "Review link is invalid.", 404);
    const lockedReservations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Reservation"
      WHERE "id" = ${invitationIdentity.reservationId}
      FOR UPDATE
    `);
    if (lockedReservations.length !== 1) throw new ReviewPolicyError("REVIEW_TOKEN_INVALID", "Review link is invalid.", 404);

    const invitation = await tx.propertyReviewInvitation.findUnique({
      where: { tokenHash: hash },
      include: { reservation: true, property: { select: { organizationId: true, timezone: true } } },
    });
    if (!invitation) throw new ReviewPolicyError("REVIEW_TOKEN_INVALID", "Review link is invalid.", 404);
    if (invitation.consumedAt || invitation.status === "CONSUMED") throw new ReviewPolicyError("REVIEW_TOKEN_CONSUMED", "This review was already submitted.", 410);
    if (!invitation.reservation.guestEmail || invitation.recipientEmailHash !== recipientEmailHash(invitation.reservation.guestEmail)) throw new ReviewPolicyError("REVIEW_TOKEN_RECIPIENT_CHANGED", "Review link is no longer assigned to the current guest.", 410);
    const expiresAt = reviewInvitationExpiresAt(invitation.reservation.checkOut);
    if (expiresAt <= now || invitation.status !== "INVITED") throw new ReviewPolicyError("REVIEW_TOKEN_EXPIRED", "Review link has expired.", 410);
    assertReviewStayEligible(invitation.reservation, { requireCheckoutCompleted: true, now });
    if (invitation.propertyId !== invitation.reservation.propertyId || invitation.organizationId !== invitation.property.organizationId) throw new ReviewPolicyError("REVIEW_INVITATION_SCOPE_INVALID", "Review invitation scope is invalid.", 409);

    const consumed = await tx.propertyReviewInvitation.updateMany({
      where: {
        id: invitation.id,
        tokenHash: hash,
        recipientEmailHash: invitation.recipientEmailHash,
        status: "INVITED",
        consumedAt: null,
      },
      data: { status: "CONSUMED", consumedAt: now },
    });
    if (consumed.count !== 1) throw new ReviewPolicyError("REVIEW_TOKEN_CONSUMED", "This review was already submitted.", 410);

    const publicSignals = detectSafetySignals(publicComment);
    const privateSignals = privateFeedback
      ? detectSafetySignals(privateFeedback)
      : [];
    const signals = [...new Set([...publicSignals, ...privateSignals])];
    const decision = initialReviewDecision(
      ratings.overallRating,
      signals,
      reviewAutoPublishEnabled(),
    );
    const review = await tx.propertyReview.create({
      data: {
        organizationId: invitation.organizationId,
        propertyId: invitation.propertyId,
        reservationId: invitation.reservationId,
        ...ratings,
        publicComment,
        privateFeedback,
        language,
        guestDisplayName: guestDisplayName(invitation.reservation.guestName),
        stayMonth: new Date(
          `${formatInTimeZone(
            invitation.reservation.checkOut,
            invitation.property.timezone ?? "America/Puerto_Rico",
            "yyyy-MM",
          )}-01T00:00:00.000Z`,
        ),
        status: decision.status,
        publishedAt: decision.status === "PUBLISHED" ? now : null,
        firstPublishedAt: decision.status === "PUBLISHED" ? now : null,
      },
    });
    const reasonCode = decision.reason ?? "AUTOMATED_SAFETY_CLEAR";
    const automatedEvidence = { automatedSignals: signals, publicSignals, privateSignals, policyVersion: "reviews_e1_v1", checkedAt: now.toISOString() };
    await tx.propertyReviewModerationCase.create({
      data: {
        organizationId: invitation.organizationId,
        propertyId: invitation.propertyId,
        reviewId: review.id,
        status: decision.status === "PUBLISHED" ? "RESOLVED_PUBLISHED" : "OPEN",
        reasonCode,
        evidence: automatedEvidence,
        resolvedAt: decision.status === "PUBLISHED" ? now : null,
        events: { create: { action: decision.status === "PUBLISHED" ? "PUBLISHED" : "CASE_OPENED", reasonCode, evidence: automatedEvidence } },
      },
    });
    return { id: review.id, status: review.status };
  });
}

export async function getPublicPropertyReviews(propertyId: string, page = 1, pageSize = 10, sortInput: unknown = "RECENT") {
  const normalizedPage = parsePositiveInteger(page, 1, 100_000);
  const take = parsePositiveInteger(pageSize, 10, 50);
  const skip = (normalizedPage - 1) * take;
  const sort = parsePublicReviewSort(sortInput);
  const orderBy = sort === "HIGHEST"
    ? [{ overallRating: "desc" as const }, { publishedAt: "desc" as const }, { id: "desc" as const }]
    : sort === "LOWEST"
      ? [{ overallRating: "asc" as const }, { publishedAt: "desc" as const }, { id: "desc" as const }]
      : [{ publishedAt: "desc" as const }, { id: "desc" as const }];
  const where = { propertyId, status: "PUBLISHED" as const, source: "PIN_GO_DIRECT" as const };
  const [reviews, total, aggregate] = await prisma.$transaction([
    prisma.propertyReview.findMany({ where, orderBy, skip, take, select: { id: true, overallRating: true, cleanlinessRating: true, accuracyRating: true, checkInAccessRating: true, communicationRating: true, locationRating: true, valueRating: true, publicComment: true, language: true, guestDisplayName: true, stayMonth: true, publishedAt: true, response: { where: { status: "PUBLISHED" }, select: { body: true, publishedAt: true } } } }),
    prisma.propertyReview.count({ where }),
    prisma.propertyReview.aggregate({ where, _avg: { overallRating: true, cleanlinessRating: true, accuracyRating: true, checkInAccessRating: true, communicationRating: true, locationRating: true, valueRating: true } }),
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { total, page: normalizedPage, pageSize: take, sort, averages: aggregate._avg, reviews };
}

export async function listOrganizationReviews(organizationId: string, status?: ReviewStatusValue, pageInput: unknown = 1, pageSizeInput: unknown = 50) {
  const page = parsePositiveInteger(pageInput, 1, 100_000);
  const pageSize = parsePositiveInteger(pageSizeInput, 50, 100);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000);
  const where = { organizationId, ...(status ? { status } : {}) };
  const activeModerationStatuses = ["OPEN", "DISPUTED"] as const;
  const [reviews, total, publishedAggregate, publishedCount, awaitingResponse, underReview, currentPeriod, previousPeriod] = await prisma.$transaction([
    prisma.propertyReview.findMany({
      where,
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      include: { property: { select: { id: true, name: true } }, response: true, moderationCases: { where: { status: { in: [...activeModerationStatuses] } }, orderBy: { openedAt: "desc" }, take: 1 } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.propertyReview.count({ where }),
    prisma.propertyReview.aggregate({ where: { organizationId, status: "PUBLISHED" }, _avg: { overallRating: true } }),
    prisma.propertyReview.count({ where: { organizationId, status: "PUBLISHED" } }),
    prisma.propertyReview.count({ where: { organizationId, status: "PUBLISHED", response: { is: null } } }),
    prisma.propertyReview.count({ where: { organizationId, OR: [
      { status: { in: ["PENDING_MODERATION", "HELD_FOR_REVIEW", "DISPUTED"] } },
      { moderationCases: { some: { status: { in: [...activeModerationStatuses] } } } },
    ] } }),
    prisma.propertyReview.aggregate({ where: { organizationId, status: "PUBLISHED", publishedAt: { gte: thirtyDaysAgo, lte: now } }, _avg: { overallRating: true } }),
    prisma.propertyReview.aggregate({ where: { organizationId, status: "PUBLISHED", publishedAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } }, _avg: { overallRating: true } }),
  ]);
  return {
    reviews,
    total,
    page,
    pageSize,
    summary: {
      overallRating: publishedAggregate._avg.overallRating,
      publishedCount,
      awaitingResponse,
      responseRate: publishedCount
        ? Number((((publishedCount - awaitingResponse) / publishedCount) * 100).toFixed(1))
        : null,
      underReview,
      ratingTrend:
        currentPeriod._avg.overallRating !== null && previousPeriod._avg.overallRating !== null
          ? Number((currentPeriod._avg.overallRating - previousPeriod._avg.overallRating).toFixed(2))
          : null,
    },
  };
}

export async function listReviewModerationQueue(pageInput: unknown = 1, pageSizeInput: unknown = 50) {
  const page = parsePositiveInteger(pageInput, 1, 100_000);
  const pageSize = parsePositiveInteger(pageSizeInput, 50, 100);
  const where: Prisma.PropertyReviewWhereInput = { OR: [
    { status: { in: ["PENDING_MODERATION", "HELD_FOR_REVIEW", "DISPUTED"] } },
    { moderationCases: { some: { status: { in: ["OPEN", "DISPUTED"] } } } },
    { response: { isNot: null } },
  ] };
  const [reviews, total] = await prisma.$transaction([
    prisma.propertyReview.findMany({
      where,
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      include: {
        property: { select: { id: true, name: true, organization: { select: { id: true, name: true } } } },
        reservation: { select: { reservationNumber: true, checkIn: true, checkOut: true } },
        moderationCases: {
          where: { status: { in: ["OPEN", "DISPUTED"] } },
          orderBy: { openedAt: "desc" },
          include: { events: { orderBy: { createdAt: "asc" } } },
        },
        response: true,
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.propertyReview.count({ where }),
  ]);
  return { reviews, total, page, pageSize };
}

export async function respondToReview(organizationId: string, userId: string, reviewId: string, body: unknown, now = new Date()) {
  const normalized = normalizeReviewText(body, "body", REVIEW_RESPONSE_MAX_LENGTH, true)!;
  const signals = detectSafetySignals(normalized);
  if (signals.length) throw new ReviewPolicyError("REVIEW_RESPONSE_SAFETY_BLOCKED", `Response contains content that cannot be published: ${signals.join(", ")}.`, 409);
  const review = await prisma.propertyReview.findFirst({ where: { id: reviewId, organizationId }, select: { id: true, status: true } });
  if (!review) throw new ReviewPolicyError("REVIEW_NOT_FOUND", "Review not found.", 404);
  if (review.status !== "PUBLISHED") throw new ReviewPolicyError("REVIEW_NOT_PUBLIC", "Only published reviews can receive a public response.", 409);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.propertyReviewResponse.findUnique({ where: { reviewId } });
    if (!existing) {
      return tx.propertyReviewResponse.create({
        data: {
          reviewId,
          authorUserId: userId,
          body: normalized,
          status: "PUBLISHED",
          publishedAt: now,
          revisions: { create: { revision: 1, authorUserId: userId, body: normalized, status: "PUBLISHED", kind: "HOST_WRITE" } },
        },
      });
    }
    if (existing.status !== "PUBLISHED") {
      throw new ReviewPolicyError("REVIEW_RESPONSE_STATUS_INVALID", "A held or removed response cannot be edited or republished.", 409);
    }
    const nextRevision = existing.revision + 1;
    const updated = await tx.propertyReviewResponse.updateMany({ where: { id: existing.id, revision: existing.revision, status: "PUBLISHED" }, data: { authorUserId: userId, body: normalized, publishedAt: now, revision: nextRevision } });
    if (updated.count !== 1) throw new ReviewPolicyError("REVIEW_RESPONSE_VERSION_CONFLICT", "The response was changed. Refresh and try again.", 409);
    await tx.propertyReviewResponseRevision.create({ data: { responseId: existing.id, revision: nextRevision, authorUserId: userId, body: normalized, status: "PUBLISHED", kind: "HOST_WRITE" } });
    return tx.propertyReviewResponse.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

export async function moderateReviewResponse(
  actorUserId: string,
  reviewId: string,
  action: ResponseModerationActionValue,
  reasonCodeInput: unknown,
  noteInput: unknown,
  expectedRevisionInput: unknown,
  now = new Date(),
) {
  const reasonCode = parseModerationReason(reasonCodeInput);
  const note = normalizeReviewText(noteInput, "note", REVIEW_COMMENT_MAX_LENGTH);
  requireResponseModerationDecision(action, reasonCode, note);
  const expectedRevision = Number(expectedRevisionInput);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new ReviewPolicyError(
      "REVIEW_RESPONSE_REVISION_REQUIRED",
      "A valid host-response revision is required.",
    );
  }

  const target = action === "PUBLISH"
    ? "PUBLISHED" as const
    : action === "HOLD"
      ? "HELD_FOR_REVIEW" as const
      : "REMOVED" as const;
  const kind = action === "PUBLISH"
    ? "MODERATION_PUBLISH" as const
    : action === "HOLD"
      ? "MODERATION_HOLD" as const
      : "MODERATION_REMOVE" as const;

  return prisma.$transaction(async (tx) => {
    const response = await tx.propertyReviewResponse.findUnique({ where: { reviewId } });
    if (!response) {
      throw new ReviewPolicyError("REVIEW_RESPONSE_NOT_FOUND", "Host response not found.", 404);
    }
    if (response.revision !== expectedRevision) {
      throw new ReviewPolicyError(
        "REVIEW_RESPONSE_VERSION_CONFLICT",
        "The host response was already changed. Refresh and try again.",
        409,
      );
    }
    assertResponseModerationTransition(response.status, action);

    const nextRevision = response.revision + 1;
    const updated = await tx.propertyReviewResponse.updateMany({
      where: {
        id: response.id,
        reviewId,
        status: response.status,
        revision: expectedRevision,
      },
      data: {
        status: target,
        publishedAt: target === "PUBLISHED" ? now : null,
        revision: nextRevision,
      },
    });
    if (updated.count !== 1) {
      throw new ReviewPolicyError(
        "REVIEW_RESPONSE_VERSION_CONFLICT",
        "The host response was already changed. Refresh and try again.",
        409,
      );
    }
    await tx.propertyReviewResponseRevision.create({
      data: {
        responseId: response.id,
        revision: nextRevision,
        authorUserId: actorUserId,
        body: response.body,
        status: target,
        kind,
        reasonCode,
        note,
      },
    });
    return {
      id: response.id,
      reviewId,
      status: target,
      revision: nextRevision,
      publishedAt: target === "PUBLISHED" ? now : null,
    };
  });
}

export async function disputeReview(organizationId: string, userId: string, reviewId: string, evidence: unknown, note: unknown) {
  const normalizedNote = normalizeReviewText(note, "note", REVIEW_COMMENT_MAX_LENGTH);
  const structuredEvidence = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as object : undefined;
  if (!normalizedNote || normalizedNote.length < 20) throw new ReviewPolicyError("REVIEW_DISPUTE_EVIDENCE_REQUIRED", "A dispute requires an evidence summary of at least 20 characters.");
  if (structuredEvidence && JSON.stringify(structuredEvidence).length > 10_000) throw new ReviewPolicyError("REVIEW_DISPUTE_EVIDENCE_TOO_LARGE", "Structured dispute evidence is too large.");
  return prisma.$transaction(async (tx) => {
    const review = await tx.propertyReview.findFirst({
      where: { id: reviewId, organizationId },
      select: { id: true, propertyId: true, status: true, moderationVersion: true },
    });
    if (!review) throw new ReviewPolicyError("REVIEW_NOT_FOUND", "Review not found.", 404);
    if (review.status === "REMOVED" || review.status === "REJECTED") throw new ReviewPolicyError("REVIEW_DISPUTE_STATUS_INVALID", "Removed or rejected reviews cannot be disputed.", 409);
    const existingCase = await tx.propertyReviewModerationCase.findFirst({ where: { reviewId, status: { in: ["OPEN", "DISPUTED"] } }, select: { id: true, status: true, evidence: true } });
    if (existingCase?.status === "DISPUTED") throw new ReviewPolicyError("REVIEW_DISPUTE_ALREADY_OPEN", "This review already has an open dispute.", 409);
    const reviewStatus = review.status === "PUBLISHED" ? "PUBLISHED" : "DISPUTED";
    const updated = await tx.propertyReview.updateMany({
      where: {
        id: reviewId,
        organizationId,
        status: review.status,
        moderationVersion: review.moderationVersion,
      },
      data: {
        status: reviewStatus,
        moderationVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new ReviewPolicyError("MODERATION_VERSION_CONFLICT", "This review was already changed by another moderator. Refresh and try again.", 409);
    const combinedEvidence = { automated: existingCase?.evidence ?? null, host: structuredEvidence ?? null };
    const moderationCase = existingCase
      ? await tx.propertyReviewModerationCase.update({ where: { id: existingCase.id }, data: { status: "DISPUTED", evidence: combinedEvidence, events: { create: { actorUserId: userId, action: "DISPUTE_OPENED", reasonCode: "OTHER_POLICY", note: normalizedNote, evidence: structuredEvidence } } } })
      : await tx.propertyReviewModerationCase.create({ data: { organizationId, propertyId: review.propertyId, reviewId, status: "DISPUTED", reasonCode: "OTHER_POLICY", evidence: combinedEvidence, events: { create: { actorUserId: userId, action: "DISPUTE_OPENED", reasonCode: "OTHER_POLICY", note: normalizedNote, evidence: structuredEvidence } } } });
    return {
      ...moderationCase,
      reviewStatus,
      moderationVersion: review.moderationVersion + 1,
    };
  });
}

export async function moderateReview(actorUserId: string, reviewId: string, action: ModerationActionValue, reasonCodeInput: unknown, noteInput: unknown, clientEvidence: unknown, expectedVersionInput: unknown, now = new Date()) {
  const reasonCode = parseModerationReason(reasonCodeInput);
  const note = normalizeReviewText(noteInput, "note", REVIEW_COMMENT_MAX_LENGTH);
  const evidenceSnapshot = await buildReviewModerationEvidence(reviewId, now);
  const moderatorEvidence = clientEvidence && typeof clientEvidence === "object" && !Array.isArray(clientEvidence) ? clientEvidence as Record<string, unknown> : null;
  if (reasonCode === "FACTUALLY_CONTRADICTED") assertEvidenceReference(evidenceSnapshot, moderatorEvidence?.reference);
  const evidence = buildReviewModerationDecisionEvidence(
    evidenceSnapshot,
    moderatorEvidence?.reference
  );
  requireModerationEvidence(action, reasonCode, note, evidence);
  const expectedVersion = Number(expectedVersionInput);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new ReviewPolicyError("MODERATION_VERSION_REQUIRED", "A valid moderation version is required.");
  const target = action === "PUBLISH" || action === "UPHOLD" ? "PUBLISHED" : action === "REJECT" ? "REJECTED" : action === "REMOVE" ? "REMOVED" : "HELD_FOR_REVIEW";
  const caseStatus = action === "PUBLISH" || action === "UPHOLD" ? "RESOLVED_PUBLISHED" : action === "REJECT" ? "RESOLVED_REJECTED" : action === "REMOVE" ? "RESOLVED_REMOVED" : "OPEN";
  return prisma.$transaction(async (tx) => {
    const review = await tx.propertyReview.findUnique({ where: { id: reviewId }, include: { moderationCases: { where: { status: { in: ["OPEN", "DISPUTED"] } }, orderBy: { openedAt: "desc" }, take: 1 } } });
    if (!review) throw new ReviewPolicyError("REVIEW_NOT_FOUND", "Review not found.", 404);
    if (review.moderationVersion !== expectedVersion) throw new ReviewPolicyError("MODERATION_VERSION_CONFLICT", "This review was already changed by another moderator. Refresh and try again.", 409);
    assertModerationTransition(review.status, action);
    const unresolvedSafetySignals = [
      ...new Set([
        ...detectSafetySignals(review.publicComment),
        ...(review.privateFeedback ? detectSafetySignals(review.privateFeedback) : []),
      ]),
    ];
    if (action === "PUBLISH" && unresolvedSafetySignals.length > 0 && (!note || note.length < 20)) throw new ReviewPolicyError("MODERATION_SAFETY_OVERRIDE_NOTE_REQUIRED", "Publishing content with an automated safety signal requires a documented override note of at least 20 characters.");
    if (action === "UPHOLD" && !review.moderationCases[0]) throw new ReviewPolicyError("MODERATION_CASE_REQUIRED", "An active dispute is required to uphold publication.", 409);
    if (action === "REMOVE" && (review.status !== "HELD_FOR_REVIEW" || !review.firstPublishedAt)) throw new ReviewPolicyError("MODERATION_REMOVAL_INVALID", "Only a previously published review on hold can be removed.", 409);
    if (action === "REJECT" && review.firstPublishedAt) throw new ReviewPolicyError("MODERATION_REJECTION_INVALID", "A previously published review must use hold and remove, not reject.", 409);
    const moderationCase = review.moderationCases[0] ?? await tx.propertyReviewModerationCase.create({ data: { organizationId: review.organizationId, propertyId: review.propertyId, reviewId, reasonCode, events: { create: { actorUserId, action: "CASE_OPENED", reasonCode, note: "Moderation case opened for a manual decision." } } } });
    const updated = await tx.propertyReview.updateMany({
      where: { id: reviewId, moderationVersion: expectedVersion, status: review.status },
      data: {
        status: target,
        publishedAt: target === "PUBLISHED" ? (review.publishedAt ?? now) : null,
        firstPublishedAt: target === "PUBLISHED" ? (review.firstPublishedAt ?? now) : review.firstPublishedAt,
        removedAt: target === "REMOVED" ? now : null,
        moderationVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new ReviewPolicyError("MODERATION_VERSION_CONFLICT", "This review was already changed by another moderator. Refresh and try again.", 409);
    await tx.propertyReviewModerationCase.update({ where: { id: moderationCase.id }, data: { status: caseStatus, resolvedAt: caseStatus === "OPEN" ? null : now, ...(evidence && typeof evidence === "object" && !Array.isArray(evidence) ? { evidence: evidence as object } : {}) } });
    await tx.propertyReviewModerationEvent.create({ data: { caseId: moderationCase.id, actorUserId, action: action === "PUBLISH" ? "PUBLISHED" : action === "UPHOLD" ? "UPHELD" : action === "REJECT" ? "REJECTED" : action === "REMOVE" ? "REMOVED" : "HELD", reasonCode, note, evidence: evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as object : undefined } });
    return { id: reviewId, status: target, moderationVersion: expectedVersion + 1 };
  });
}
