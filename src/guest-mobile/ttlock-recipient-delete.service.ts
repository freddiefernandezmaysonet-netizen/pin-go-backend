import axios from "axios";
import type { PrismaClient } from "@prisma/client";
import { tombstoneDeletedTTLockRecipient } from "./ttlock-recipient-retention.service.js";

const BASE_URL = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

function clientCredentials() {
  const clientId = String(process.env.TTLOCK_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.TTLOCK_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) throw new Error("TTLOCK_CLIENT_CREDENTIALS_MISSING");
  return { clientId, clientSecret };
}

export async function deleteTTLockRecipientIdentity(
  prisma: PrismaClient,
  identityId: string,
  now = new Date(),
) {
  const identity = await prisma.tTLockRecipientIdentity.findUnique({
    where: { id: identityId },
    select: { id: true, username: true, status: true },
  });
  if (!identity) return { ok: true as const, skipped: "NOT_FOUND" as const };
  if (identity.status === "DELETED") return { ok: true as const, skipped: "ALREADY_DELETED" as const };
  if (identity.status !== "DELETE_PENDING") throw new Error("TTLOCK_RECIPIENT_DELETE_NOT_AUTHORIZED");

  const { clientId, clientSecret } = clientCredentials();
  try {
    await axios.post(`${BASE_URL}/v3/user/delete`, null, {
      params: { clientId, clientSecret, username: identity.username, date: Date.now() },
      timeout: 15000,
    });
  } catch (error) {
    await prisma.tTLockRecipientIdentity.update({
      where: { id: identity.id },
      data: { lastError: error instanceof Error ? error.message.slice(0, 500) : "TTLOCK_RECIPIENT_DELETE_FAILED" },
    });
    throw error;
  }

  await tombstoneDeletedTTLockRecipient(prisma, identity.id, now);
  return { ok: true as const, deleted: true as const };
}
