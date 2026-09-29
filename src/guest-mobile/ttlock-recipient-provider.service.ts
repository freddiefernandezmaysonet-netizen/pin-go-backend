import axios from "axios";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { encryptMobileAccessSecret } from "./mobile-access-crypto.service.js";

const BASE_URL = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

function clientCredentials() {
  const clientId = String(process.env.TTLOCK_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.TTLOCK_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) throw new Error("TTLOCK_CLIENT_CREDENTIALS_MISSING");
  return { clientId, clientSecret };
}

function identityAad(id: string, kind: "password" | "access-token" | "refresh-token") {
  return `mobile-access:ttlock-recipient:v1:${id}:${kind}`;
}

export function generateTTLockRecipientPassword() {
  return randomBytes(32).toString("base64url");
}

export async function registerAndAuthenticateTTLockRecipient(
  prisma: PrismaClient,
  input: Readonly<{ identityId: string; username: string }>,
) {
  const identity = await prisma.tTLockRecipientIdentity.findUnique({ where: { id: input.identityId } });
  if (!identity || identity.username !== input.username) throw new Error("TTLOCK_RECIPIENT_IDENTITY_NOT_FOUND");
  if (identity.status === "ACTIVE" && identity.accessTokenCiphertext && identity.refreshTokenCiphertext) {
    return { identityId: identity.id, reused: true as const };
  }

  const { clientId, clientSecret } = clientCredentials();
  const password = generateTTLockRecipientPassword();
  const passwordMd5 = createHash("md5").update(password, "utf8").digest("hex");
  const date = Date.now();

  try {
    await axios.post(`${BASE_URL}/v3/user/register`, null, {
      params: { clientId, clientSecret, username: identity.username, password: passwordMd5, date },
      timeout: 15000,
    });

    const token = await axios.post(`${BASE_URL}/oauth2/token`, new URLSearchParams({
      clientId,
      clientSecret,
      username: identity.username,
      password,
      grant_type: "password",
    }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const accessToken = String(token.data?.access_token ?? "");
    const refreshToken = String(token.data?.refresh_token ?? "");
    const uid = token.data?.uid == null ? null : String(token.data.uid);
    const expiresIn = Number(token.data?.expires_in);
    if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("TTLOCK_RECIPIENT_TOKEN_INCOMPLETE");
    }

    const passwordEnc = encryptMobileAccessSecret(password, identityAad(identity.id, "password"));
    const accessEnc = encryptMobileAccessSecret(accessToken, identityAad(identity.id, "access-token"));
    const refreshEnc = encryptMobileAccessSecret(refreshToken, identityAad(identity.id, "refresh-token"));
    if (passwordEnc.keyVersion !== accessEnc.keyVersion || accessEnc.keyVersion !== refreshEnc.keyVersion) {
      throw new Error("MOBILE_ACCESS_KEY_VERSION_CHANGED_DURING_WRITE");
    }

    await prisma.tTLockRecipientIdentity.update({
      where: { id: identity.id },
      data: {
        passwordCiphertext: passwordEnc.ciphertext,
        passwordKeyVersion: passwordEnc.keyVersion,
        accessTokenCiphertext: accessEnc.ciphertext,
        refreshTokenCiphertext: refreshEnc.ciphertext,
        tokenKeyVersion: accessEnc.keyVersion,
        providerUid: uid,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        status: "ACTIVE",
        registeredAt: new Date(),
        lastError: null,
      },
    });

    return { identityId: identity.id, reused: false as const };
  } catch (error) {
    await prisma.tTLockRecipientIdentity.update({
      where: { id: identity.id },
      data: { status: "FAILED", lastError: error instanceof Error ? error.message.slice(0, 500) : "TTLOCK_RECIPIENT_REGISTER_FAILED" },
    });
    throw error;
  }
}
