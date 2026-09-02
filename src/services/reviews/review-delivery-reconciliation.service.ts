import type { PrismaClient } from "@prisma/client";

import {
  markReviewInvitationDelivery,
  type ReviewInvitationDeliveryFence,
} from "./review.service.js";

export async function markReviewInvitationDeliveredOrThrow(
  input: {
    invitationId: string;
    deliveryFence: ReviewInvitationDeliveryFence;
    providerMessageId?: string | null;
    providerAcceptedAt?: Date;
    recordProviderAttempt?: boolean;
  },
  client: PrismaClient
): Promise<void> {
  const result = await markReviewInvitationDelivery(
    {
      invitationId: input.invitationId,
      deliveryFence: input.deliveryFence,
      delivered: true,
      providerMessageId: input.providerMessageId ?? null,
      providerAcceptedAt: input.providerAcceptedAt,
      recordProviderAttempt: input.recordProviderAttempt,
    },
    client
  );

  if (
    result &&
    !Array.isArray(result) &&
    Number(result.count) > 0
  ) {
    return;
  }

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
    invitation?.tokenHash === input.deliveryFence.tokenHash &&
    invitation?.recipientEmailHash ===
      input.deliveryFence.recipientEmailHash &&
    String(invitation.reservation.guestEmail ?? "")
      .trim()
      .toLowerCase() ===
      String(input.deliveryFence.recipientEmail ?? "")
        .trim()
        .toLowerCase() &&
    (invitation.deliveryStatus === "SENT" ||
      invitation.status === "CONSUMED" ||
      invitation.consumedAt)
  ) {
    return;
  }

  throw new Error(
    "DIRECT_BOOKING_REVIEW_DELIVERY_STATE_NOT_UPDATED"
  );
}
