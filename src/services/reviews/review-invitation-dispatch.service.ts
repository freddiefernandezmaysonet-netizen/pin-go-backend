import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { REVIEW_INVITATION_DELAY_MS } from "../../config/reviews.config.js";
import { sendReviewInvitationEmail } from "../../lib/mailer.js";
import { sendLoggedEmail } from "../email-delivery.service.js";
import { resolveOrganizationGuestReplyTo } from "../organization-guest-email.service.js";
import {
  assertReviewInvitationDeliveryFence,
  createReviewInvitation,
  markReviewInvitationDelivery,
} from "./review.service.js";
import { markReviewInvitationDeliveredOrThrow } from "./review-delivery-reconciliation.service.js";

function reviewUrl(token: string) {
  const origin = String(process.env.APP_BASE_URL ?? "http://localhost:5173")
    .trim().replace(/\/+$/, "");
  return `${origin}/review#token=${encodeURIComponent(token)}`;
}

function idempotencyKey(invitationId: string, tokenHash: string) {
  return `direct-booking-review-invitation:${createHash("sha256")
    .update(`${invitationId}:${tokenHash}`).digest("hex")}`;
}

function sanitizeReviewDeliveryError(value: unknown) {
  return String(value instanceof Error ? `${value.name}: ${value.message}` : value ?? "Delivery failed")
    .replace(/https?:\/\/[^\s<>'"]*\/review[^\s<>'"]*/gi, "[REDACTED_REVIEW_URL]")
    .replace(/\b[A-Za-z0-9_-]{40,256}\b/g, "[REDACTED_TOKEN]")
    .replace(/\s+/g, " ").trim().slice(0, 5_000) || "Delivery failed";
}

export async function claimReviewInvitationDelivery(input: {
  prisma: Pick<PrismaClient, "propertyReviewInvitation">;
  invitationId: string;
  tokenHash: string;
  recipientEmailHash: string;
  now: Date;
  leaseOwner: string;
}) {
  return input.prisma.propertyReviewInvitation.updateMany({
    where: {
      id: input.invitationId,
      tokenHash: input.tokenHash,
      recipientEmailHash: input.recipientEmailHash,
      deliveryStatus: { in: ["PENDING", "FAILED", "PROCESSING"] },
      deliveryAttemptCount: { lt: 5 },
      consumedAt: null,
      OR: [
        { deliveryLeaseExpiresAt: null },
        { deliveryLeaseExpiresAt: { lte: input.now } },
      ],
    },
    data: {
      deliveryStatus: "PROCESSING",
      deliveryLeaseOwner: input.leaseOwner,
      deliveryLeaseExpiresAt: new Date(input.now.getTime() + 5 * 60 * 1000),
    },
  });
}

export async function dispatchPostCheckoutReviewInvitations(input: {
  prisma: PrismaClient;
  now?: Date;
  batchSize?: number;
}) {
  const now = input.now ?? new Date();
  const eligibleCheckout = new Date(now.getTime() - REVIEW_INVITATION_DELAY_MS);
  const retryCutoff = new Date(now.getTime() - 15 * 60 * 1000);
  const candidates = await input.prisma.reservation.findMany({
    where: {
      source: "DIRECT_BOOKING",
      externalProvider: "PIN_GO_DIRECT",
      status: "ACTIVE",
      cancelledAt: null,
      paymentState: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
      amountCollected: { gt: 0 },
      guestEmail: { not: null },
      checkOut: { lte: eligibleCheckout },
      review: null,
      OR: [
        { reviewInvitation: null },
        { reviewInvitation: { deliveryStatus: "PENDING", consumedAt: null } },
        { reviewInvitation: {
          deliveryStatus: "FAILED",
          deliveryAttemptCount: { lt: 5 },
          lastDeliveryAttemptAt: { lte: retryCutoff },
          consumedAt: null,
        } },
        { reviewInvitation: {
          deliveryStatus: "PROCESSING",
          deliveryAttemptCount: { lt: 5 },
          deliveryLeaseExpiresAt: { lte: now },
          consumedAt: null,
        } },
      ],
    },
    select: { id: true, guestName: true },
    orderBy: { checkOut: "asc" },
    take: Math.min(Math.max(input.batchSize ?? 20, 1), 100),
  });

  const results = [];
  for (const candidate of candidates) {
    let claimed: Awaited<ReturnType<typeof createReviewInvitation>> | null = null;
    let providerAttempted = false;
    try {
      const invitation = await createReviewInvitation(candidate.id, now, input.prisma);
      const leaseOwner = `review-invitation:${randomUUID()}`;
      const lease = await claimReviewInvitationDelivery({
        prisma: input.prisma,
        invitationId: invitation.invitation.id,
        tokenHash: invitation.deliveryFence.tokenHash,
        recipientEmailHash: invitation.deliveryFence.recipientEmailHash,
        now,
        leaseOwner,
      });
      if (lease.count !== 1) {
        results.push({ reservationId: candidate.id, status: "SKIPPED" });
        continue;
      }
      claimed = invitation;
      await assertReviewInvitationDeliveryFence({
        invitationId: invitation.invitation.id,
        deliveryFence: invitation.deliveryFence,
        to: invitation.guestEmail,
        now,
      }, input.prisma);
      const replyTo = await resolveOrganizationGuestReplyTo(
        input.prisma,
        (await input.prisma.propertyReviewInvitation.findUniqueOrThrow({
          where: { id: invitation.invitation.id },
          select: { organizationId: true },
        })).organizationId
      );
      const delivery = await sendLoggedEmail({
        prisma: input.prisma,
        type: "DIRECT_BOOKING_REVIEW_INVITATION",
        to: invitation.guestEmail,
        subject: `Review invitation - ${invitation.propertyName}`,
        reservationId: candidate.id,
        retryPayload: { invitationId: invitation.invitation.id },
        send: async () => {
          providerAttempted = true;
          return sendReviewInvitationEmail({
            to: invitation.guestEmail,
            replyTo: replyTo.email,
            guestName: candidate.guestName,
            propertyName: invitation.propertyName,
            reviewUrl: reviewUrl(invitation.token),
            preferredLanguage: invitation.language,
            idempotencyKey: idempotencyKey(
              invitation.invitation.id,
              invitation.deliveryFence.tokenHash
            ),
          });
        },
      });
      if (!delivery.ok) throw new Error(delivery.error ?? "REVIEW_INVITATION_SEND_FAILED");
      await markReviewInvitationDeliveredOrThrow({
        invitationId: invitation.invitation.id,
        deliveryFence: invitation.deliveryFence,
        providerMessageId: delivery.providerMessageId ?? null,
      }, input.prisma);
      results.push({ reservationId: candidate.id, status: "SENT" });
    } catch (error) {
      if (claimed) {
        await markReviewInvitationDelivery({
          invitationId: claimed.invitation.id,
          deliveryFence: claimed.deliveryFence,
          delivered: false,
          error: sanitizeReviewDeliveryError(error),
          now,
          recordProviderAttempt: providerAttempted,
        }, input.prisma).catch(() => undefined);
      }
      results.push({ reservationId: candidate.id, status: "FAILED" });
    }
  }
  return results;
}
