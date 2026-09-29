import type { PrismaClient } from "@prisma/client";
import { deactivateGrant } from "../services/ttlock/ttlock.brain.js";
import { reconcileMobileAccessRevocationSidecar } from "./mobile-access-revocation-sidecar.service.js";

export async function deactivateGuestAccessWithMobileSidecar(
  prisma: PrismaClient,
  input: Readonly<{
    accessGrantId: string;
    revokeCredential: (credentialId: string) => Promise<unknown>;
  }>,
) {
  const canonical = await deactivateGrant(input.accessGrantId);

  if (process.env.MOBILE_ACCESS_EKEY_ENABLED !== "true") {
    return { canonical, mobile: { status: "DISABLED" as const } };
  }

  try {
    const mobile = await reconcileMobileAccessRevocationSidecar(prisma, {
      accessGrantId: input.accessGrantId,
      revokeCredential: input.revokeCredential,
    });
    return { canonical, mobile };
  } catch (error) {
    return {
      canonical,
      mobile: {
        status: "RECOVERY_REQUIRED" as const,
        error: error instanceof Error ? error.message : "MOBILE_ACCESS_SIDECAR_FAILED",
      },
    };
  }
}
