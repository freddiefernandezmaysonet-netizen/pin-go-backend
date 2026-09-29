import type { PrismaClient } from "@prisma/client";
import type { MobileAccessProvider } from "./mobile-access-provider.js";
import { resolveOrCreateTTLockRecipientIdentity } from "./ttlock-recipient-identity.service.js";
import { registerAndAuthenticateTTLockRecipient } from "./ttlock-recipient-provider.service.js";
import { issueMobileAccessForGuestSession } from "./mobile-access-issuance.service.js";

export async function prepareMobileAccessOnDemand(
  prisma: PrismaClient,
  input: Readonly<{
    guestDeviceSessionId: string;
    reservationId: string;
    providerFactory: (scope: {
      organizationId: string;
      recipientIdentityId: string;
    }) => MobileAccessProvider;
  }>,
) {
  const session = await prisma.guestDeviceSession.findFirst({
    where: { id: input.guestDeviceSessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, guestPersonId: true },
  });
  if (!session) throw new Error("MOBILE_ACCESS_SESSION_NOT_FOUND");

  const stay = await prisma.guestStayLink.findFirst({
    where: {
      guestPersonId: session.guestPersonId,
      reservationId: input.reservationId,
      revokedAt: null,
    },
    select: {
      reservation: {
        select: {
          id: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });
  if (!stay?.reservation) throw new Error("MOBILE_ACCESS_STAY_NOT_LINKED");

  let identity = await resolveOrCreateTTLockRecipientIdentity(prisma, session.guestPersonId);
  if (identity.status !== "ACTIVE") {
    await registerAndAuthenticateTTLockRecipient(prisma, {
      identityId: identity.id,
      username: identity.username,
    });
    const refreshed = await prisma.tTLockRecipientIdentity.findUnique({ where: { id: identity.id } });
    if (!refreshed || refreshed.status !== "ACTIVE") throw new Error("TTLOCK_RECIPIENT_NOT_ACTIVE");
    identity = refreshed;
  }

  const provider = input.providerFactory({
    organizationId: stay.reservation.property.organizationId,
    recipientIdentityId: identity.id,
  });

  return issueMobileAccessForGuestSession(prisma, provider, {
    guestDeviceSessionId: session.id,
    reservationId: stay.reservation.id,
    recipient: identity.username,
  });
}
