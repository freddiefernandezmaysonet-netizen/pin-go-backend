import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { getOrgTtlockAccessToken } from "../services/ttlock/ttlock.org-auth";

type TokenCache = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null;

let globalCache: TokenCache = null;
const orgCache = new Map<string, { accessToken: string; expiresAt: number }>();

const BASE = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

function md5(text: string) {
  return crypto.createHash("md5").update(text).digest("hex");
}

async function requestNewToken() {
  const clientId = process.env.TTLOCK_CLIENT_ID ?? "";
  const clientSecret = process.env.TTLOCK_CLIENT_SECRET ?? "";
  const username = process.env.TTLOCK_USERNAME ?? "";
  const passwordPlain = process.env.TTLOCK_PASSWORD_PLAIN ?? "";

  const passwordMd5 = md5(passwordPlain);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password: passwordMd5,
    grant_type: "password",
  });

  const resp = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await resp.json();

  if (!resp.ok || !data.access_token) {
    throw new Error(`TTLock auth failed: ${JSON.stringify(data)}`);
  }

  globalCache = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000,
  };

  return globalCache.accessToken;
}

async function refreshAccessToken() {
  if (!globalCache?.refreshToken) {
    return requestNewToken();
  }

  const body = new URLSearchParams({
    client_id: process.env.TTLOCK_CLIENT_ID ?? "",
    client_secret: process.env.TTLOCK_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: globalCache.refreshToken,
  });

  const resp = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await resp.json();

  if (!resp.ok || !data.access_token) {
    return requestNewToken();
  }

  globalCache = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 0) * 1000,
  };

  return globalCache.accessToken;
}

/**
 * LEGACY / DEV FALLBACK
 * Mantiene compatibilidad con el flujo actual basado en .env.
 */
export async function getDeviceHealthAccessToken() {
  if (!globalCache) {
    return requestNewToken();
  }

  if (Date.now() > globalCache.expiresAt - 60000) {
    return refreshAccessToken();
  }

  return globalCache.accessToken;
}

/**
 * NUEVO: token por organización
 */
export async function getDeviceHealthAccessTokenForOrg(organizationId: string) {
  try {
    const cached = orgCache.get(organizationId);

    if (cached && Date.now() < cached.expiresAt - 60000) {
      return cached.accessToken;
    }

    const accessToken = await getOrgTtlockAccessToken(prisma, organizationId);

    // TTL corto local para evitar resolver DB a cada llamada
    orgCache.set(organizationId, {
      accessToken,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return accessToken;
  } catch (error) {
    console.warn(
      `[TTLOCK][deviceHealth] org token failed for organization ${organizationId}, fallback to .env`,
      error
    );
    return getDeviceHealthAccessToken();
  }
}

/**
 * NUEVO: token por property
 */
export async function getDeviceHealthAccessTokenForProperty(propertyId: string) {
  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { organizationId: true },
    });

    const organizationId = property?.organizationId ?? null;

    if (!organizationId) {
      console.warn(
        `[TTLOCK][deviceHealth] property ${propertyId} without organizationId, fallback to .env`
      );
      return getDeviceHealthAccessToken();
    }

    return getDeviceHealthAccessTokenForOrg(organizationId);
  } catch (error) {
    console.warn(
      `[TTLOCK][deviceHealth] property lookup failed for ${propertyId}, fallback to .env`,
      error
    );
    return getDeviceHealthAccessToken();
  }
}

/**
 * NUEVO: token por lock interna de Pin&Go
 */
export async function getDeviceHealthAccessTokenForLock(lockId: string) {
  try {
    const lock = await prisma.lock.findUnique({
      where: { id: lockId },
      select: {
        property: {
          select: {
            organizationId: true,
          },
        },
      },
    });

    const organizationId = lock?.property?.organizationId ?? null;

    if (!organizationId) {
      console.warn(
        `[TTLOCK][deviceHealth] lock ${lockId} without organizationId, fallback to .env`
      );
      return getDeviceHealthAccessToken();
    }

    return getDeviceHealthAccessTokenForOrg(organizationId);
  } catch (error) {
    console.warn(
      `[TTLOCK][deviceHealth] lock lookup failed for ${lockId}, fallback to .env`,
      error
    );
    return getDeviceHealthAccessToken();
  }
}

/**
 * NUEVO: token por ttlockLockId
 */
export async function getDeviceHealthAccessTokenForTtlockLock(ttlockLockId: number) {
  try {
    const lock = await prisma.lock.findUnique({
      where: { ttlockLockId },
      select: {
        property: {
          select: {
            organizationId: true,
          },
        },
      },
    });

    const organizationId = lock?.property?.organizationId ?? null;

    if (!organizationId) {
      console.warn(
        `[TTLOCK][deviceHealth] ttlockLockId ${ttlockLockId} without organizationId, fallback to .env`
      );
      return getDeviceHealthAccessToken();
    }

    return getDeviceHealthAccessTokenForOrg(organizationId);
  } catch (error) {
    console.warn(
      `[TTLOCK][deviceHealth] ttlock lock lookup failed for ${ttlockLockId}, fallback to .env`,
      error
    );
    return getDeviceHealthAccessToken();
  }
}