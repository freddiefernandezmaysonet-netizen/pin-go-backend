import type { PrismaClient } from "@prisma/client";
import type { MobileAccessProvider } from "./mobile-access-provider.js";
import { provisionMobileAccessCredential } from "./mobile-access-provisioning.service.js";

export async function issueMobileAccessForGuestSession(
  prisma: PrismaClient,
  provider: MobileAccessProvider,
  input: Readonly<{
    guestDeviceSessionId: string;
    reservationId: string;
    recipient: string;
    now?: Date;
  }>,
) {
  if (!input.guestDeviceSessionId || !input.reservationId || !input.recipient.trim()) {
    throw new Error("MOBILE_ACCESS_ISSUANCE_INPUT_INVALID");
  }

  return provisionMobileAccessCredential(prisma, provider, {
    guestDeviceSessionId: input.guestDeviceSessionId,
    reservationId: input.reservationId,
    recipient: input.recipient.trim(),
    now: input.now,
  });
}
