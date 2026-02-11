import { prisma } from "../../lib/prisma";
import { TTLockClient } from "./ttlock.client";

export async function getTTLockClientForOrg(organizationId: string) {
  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId },
  });

  if (!auth?.accessToken) {
    throw new Error("TTLock not connected for organization");
  }

  return new TTLockClient(auth.accessToken);
}
