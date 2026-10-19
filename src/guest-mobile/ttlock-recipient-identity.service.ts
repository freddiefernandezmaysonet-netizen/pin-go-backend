import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { encryptMobileAccessSecret } from "./mobile-access-crypto.service.js";

function opaqueLocalPart(guestPersonId: string) {
  const salt = String(process.env.TTLOCK_RECIPIENT_USERNAME_SALT ?? "").trim();
  if (salt.length < 32) throw new Error("TTLOCK_RECIPIENT_USERNAME_SALT_NOT_CONFIGURED");
  return createHash("sha256").update(`${salt}:${guestPersonId}`).digest("hex").slice(0, 32);
}

export async function resolveOrCreateTTLockRecipientIdentity(
  prisma: PrismaClient,
  guestPersonId: string,
) {
  const existing = await prisma.tTLockRecipientIdentity.findUnique({ where: { guestPersonId } });
  if (existing && existing.status !== "DELETED") return existing;

  const username = `guest${opaqueLocalPart(guestPersonId)}`;
  const bootstrapSecret = randomBytes(32).toString("base64url");
  const encrypted = encryptMobileAccessSecret(
    bootstrapSecret,
    `mobile-access:ttlock-recipient:v1:pending:${guestPersonId}:bootstrap`,
  );

  if (existing?.status === "DELETED") {
    return prisma.tTLockRecipientIdentity.update({
      where: { id: existing.id },
      data: {
        username,
        passwordCiphertext: encrypted.ciphertext,
        passwordKeyVersion: encrypted.keyVersion,
        status: "PENDING",
        registeredAt: null,
        lastActivityAt: null,
        deleteRequestedAt: null,
        deletedAt: null,
        lastError: null,
      },
    });
  }

  return prisma.tTLockRecipientIdentity.create({
    data: {
      guestPersonId,
      username,
      passwordCiphertext: encrypted.ciphertext,
      passwordKeyVersion: encrypted.keyVersion,
      status: "PENDING",
    },
  });
}

