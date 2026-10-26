import axios from "axios";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { decryptMobileAccessSecret, encryptMobileAccessSecret } from "./mobile-access-crypto.service.js";

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
  if (!["PENDING", "FAILED"].includes(identity.status)) throw new Error("TTLOCK_RECIPIENT_NOT_REGISTERABLE");
  if (!identity.passwordCiphertext || !identity.passwordKeyVersion) throw new Error("TTLOCK_RECIPIENT_PASSWORD_MISSING");
  let password: string;
  try {
    password = decryptMobileAccessSecret(identity.passwordCiphertext, identity.passwordKeyVersion, identityAad(identity.id, "password"));
  } catch {
    // Older failed registrations discarded their actual provider password. Never
    // silently overwrite/reset a remote account with an unrelated bootstrap secret.
    if (identity.status !== "PENDING" || identity.registeredAt) throw new Error("TTLOCK_RECIPIENT_RECOVERY_REQUIRED");
    password = decryptMobileAccessSecret(identity.passwordCiphertext, identity.passwordKeyVersion,
      `mobile-access:ttlock-recipient:v1:pending:${identity.guestPersonId}:bootstrap`);
    const saved = encryptMobileAccessSecret(password, identityAad(identity.id, "password"));
    await prisma.tTLockRecipientIdentity.update({ where: { id: identity.id }, data: {
      passwordCiphertext: saved.ciphertext, passwordKeyVersion: saved.keyVersion,
    } });
  }
  const passwordMd5 = createHash("md5").update(password, "utf8").digest("hex");
  const date = Date.now();

  try {
    let username = identity.username;
    if (!identity.registeredAt) {
      // The old generated email-shaped name is invalid for cloud registration.
      // Normalize only our exact legacy format, never a registered account.
      const legacy = /^guest-([a-f0-9]{32})@[a-z0-9.-]+\.[a-z]{2,}$/i.exec(username);
      if (legacy?.[1]) {
        if (identity.providerUid || identity.accessTokenCiphertext || identity.refreshTokenCiphertext) {
          throw new Error("TTLOCK_RECIPIENT_RECOVERY_REQUIRED");
        }
        username = `guest${legacy[1].toLowerCase()}`;
        await prisma.tTLockRecipientIdentity.update({ where: { id: identity.id }, data: { username } });
      }
      if (!/^[a-zA-Z0-9]+$/.test(username)) throw new Error("TTLOCK_RECIPIENT_USERNAME_INVALID");
      const registration = await axios.post(`${BASE_URL}/v3/user/register`, null, {
        params: { clientId, clientSecret, username, password: passwordMd5, date },
        timeout: 15000,
      });
      if (registration.data?.errcode != null && Number(registration.data.errcode) !== 0) {
        throw new Error("TTLOCK_RECIPIENT_REGISTER_REJECTED");
      }
      if (typeof registration.data?.username !== "string" || !registration.data.username.trim()) {
        throw new Error("TTLOCK_RECIPIENT_REGISTER_INCOMPLETE");
      }
      username = registration.data.username.trim();
      // Persist the canonical username before OAuth so token failures can retry.
      await prisma.tTLockRecipientIdentity.update({ where: { id: identity.id }, data: {
        username, registeredAt: new Date(),
      } });
    }

    const token = await axios.post(`${BASE_URL}/oauth2/token`, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password: passwordMd5,
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
        lastActivityAt: new Date(),
        lastError: null,
      },
    });

    return { identityId: identity.id, reused: false as const };
  } catch (error) {
    // Do not persist Axios messages/config: they can contain credentials.
    const code = error instanceof Error && /^TTLOCK_RECIPIENT_[A-Z_]+$/.test(error.message)
      ? error.message : "TTLOCK_RECIPIENT_AUTH_FAILED";
    await prisma.tTLockRecipientIdentity.update({
      where: { id: identity.id },
      data: { status: "FAILED", lastError: code },
    });
    throw new Error(code);
  }
}

