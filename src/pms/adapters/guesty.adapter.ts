import type { PmsAdapter, CanonicalReservation } from "./types";
import axios from "axios";
import crypto from "crypto";

const GUESTY_BASE_URL = "https://open-api.guesty.com/v1";
const GUESTY_AUTH_URL = "https://open-api.guesty.com/oauth2/token";

type GuestyCredentials = {
  accessToken?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
};

type GuestyTokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

const guestyTokenCache = new Map<string, GuestyTokenCacheEntry>();

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) {
    throw new Error("PMS_CREDENTIALS_SECRET not configured");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptCredentialsIfNeeded(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error("GUESTY_NO_CREDENTIALS");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GUESTY_BAD_CREDENTIALS_JSON");
  }

  // Compatibilidad hacia atrás:
  // si ya viene como JSON plano con accessToken/clientId/clientSecret
  if (
    parsed &&
    !parsed.alg &&
    !parsed.iv &&
    !parsed.tag &&
    !parsed.data
  ) {
    return JSON.stringify(parsed);
  }

  // Nuevo formato cifrado AES-256-GCM
  if (
    parsed?.alg !== "aes-256-gcm" ||
    !parsed?.iv ||
    !parsed?.tag ||
    !parsed?.data
  ) {
    throw new Error("GUESTY_BAD_CREDENTIALS_FORMAT");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(String(parsed.iv), "base64");
  const tag = Buffer.from(String(parsed.tag), "base64");
  const encrypted = Buffer.from(String(parsed.data), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function parseCredentials(connection: { credentialsEncrypted?: string | null }) {
  if (!connection.credentialsEncrypted) throw new Error("GUESTY_NO_CREDENTIALS");

  let creds: any;
  try {
    const decryptedJson = decryptCredentialsIfNeeded(connection.credentialsEncrypted);
    creds = JSON.parse(decryptedJson);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (
      msg === "GUESTY_NO_CREDENTIALS" ||
      msg === "GUESTY_BAD_CREDENTIALS_JSON" ||
      msg === "GUESTY_BAD_CREDENTIALS_FORMAT" ||
      msg === "PMS_CREDENTIALS_SECRET not configured"
    ) {
      throw err;
    }
    throw new Error("GUESTY_CREDENTIALS_DECRYPT_FAILED");
  }

  return {
    accessToken: creds?.accessToken ? String(creds.accessToken) : null,
    clientId: creds?.clientId ? String(creds.clientId) : null,
    clientSecret: creds?.clientSecret ? String(creds.clientSecret) : null,
  } satisfies GuestyCredentials;
}

/**
 * Compatibilidad hacia atrás:
 * - Si la conexión vieja tiene accessToken guardado, lo usamos.
 * - Si la conexión nueva tiene clientId/clientSecret, hacemos OAuth2 real.
 */
async function getAccessTokenOrThrow(connection: {
  id?: string | null;
  credentialsEncrypted?: string | null;
}) {
  const creds = parseCredentials(connection);

  if (creds.accessToken) {
    return creds.accessToken;
  }

  if (!creds.clientId || !creds.clientSecret) {
    throw new Error("GUESTY_NO_ACCESS_TOKEN");
  }

  const cacheKey = String(connection.id ?? `${creds.clientId}:guesty`);
  const cached = guestyTokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "open-api",
  });

  const resp = await axios.post(GUESTY_AUTH_URL, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
    },
    timeout: 15000,
  });

  const accessToken = resp.data?.access_token;
  const expiresIn = Number(resp.data?.expires_in ?? 86400);

  if (!accessToken) {
    throw new Error("GUESTY_TOKEN_RESPONSE_INVALID");
  }

  guestyTokenCache.set(cacheKey, {
    accessToken: String(accessToken),
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return String(accessToken);
}

/**
 * Mapea la respuesta real de Guesty a tu CanonicalReservation.
 * Nota: algunos paths pueden variar según el payload que veas.
 * Ajustamos cuando hagas el primer fetch real.
 */
function mapGuestyReservationToCanonical(externalReservationId: string, r: any): CanonicalReservation {
  const externalListingId =
    r?.listingId ?? r?.listing?._id ?? r?.listing?.id ?? r?.propertyId ?? r?.property?._id ?? r?.property?.id;

  // Guesty puede traer fechas con distintos nombres; dejamos varios fallbacks.
  const checkInRaw = r?.checkIn ?? r?.checkInDate ?? r?.checkInDateLocalized ?? r?.startDate;
  const checkOutRaw = r?.checkOut ?? r?.checkOutDate ?? r?.checkOutDateLocalized ?? r?.endDate;

  // Guest info
  const guestName =
    r?.guest?.fullName ??
    [r?.guest?.firstName, r?.guest?.lastName].filter(Boolean).join(" ") ??
    r?.guestName;

  const listingName =
    r?.listing?.title ?? r?.listing?.nickname ?? r?.listingTitle ?? null;

  // Status (ajustaremos cuando veas el enum exacto)
  const status: CanonicalReservation["status"] =
    ["cancelled", "canceled"].includes(String(r?.status ?? "").toLowerCase())
      ? "CANCELLED"
      : "CONFIRMED";

  if (!externalListingId) throw new Error("GUESTY_RESERVATION_MISSING_LISTING_ID");
  if (!checkInRaw || !checkOutRaw) throw new Error("GUESTY_RESERVATION_MISSING_DATES");

  return {
    provider: "GUESTY",
    externalReservationId,
    externalListingId: String(externalListingId),
    status,
    checkIn: new Date(checkInRaw).toISOString(),
    checkOut: new Date(checkOutRaw).toISOString(),
    listingName,
    timezone: r?.timezone ?? r?.listing?.timezone,
    guest: {
      name: guestName,
      email: r?.guest?.email ?? r?.guestEmail,
      phone: r?.guest?.phone ?? r?.guestPhone,
    },
    notes: r?.notes ?? r?.guestNote,
  };
}

export const guestyAdapter: PmsAdapter = {
  provider: "GUESTY",

  parseWebhook: ({ body }) => {
    const eventType = body?.eventType ?? body?.event ?? "RESERVATION";
    const externalEventId = body?.externalEventId ?? body?.id ?? null;

    // ✅ MODO TEST: si viene reservation ya normalizada
    if (
      body?.reservation?.externalReservationId &&
      body?.reservation?.externalListingId
    ) {
      return {
        eventType,
        externalEventId,
        reservation: body.reservation as CanonicalReservation,
      };
    }

    // ✅ FALLBACK: si viene solo reservationId
    const externalReservationId =
      body?.reservationId ??
      body?.reservation_id ??
      body?.data?.reservationId ??
      body?.data?.reservation_id ??
      body?.reservation?._id ??
      body?.reservation?.id;

    return {
      eventType,
      externalEventId,
      externalReservationId,
    };
  },

  /**
   * ✅ MODO REAL:
   * Webhook trae solo reservationId → hacemos GET /reservations/:id
   */
  fetchReservation: async ({ connection, externalReservationId }) => {
    if (!externalReservationId) {
      throw new Error("GUESTY_MISSING_EXTERNAL_RESERVATION_ID");
    }

    try {
      const accessToken = await getAccessTokenOrThrow(connection);

      const url = `${GUESTY_BASE_URL}/reservations/${encodeURIComponent(externalReservationId)}`;

      const resp = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        timeout: 15000,
      });

      // Dependiendo del wrapper de Guesty, puede venir en resp.data o resp.data.data
      const payload = resp.data?.data ?? resp.data;

      return mapGuestyReservationToCanonical(externalReservationId, payload);
    } catch (err: any) {
      console.error("❌ Guesty fetchReservation error:", {
        externalReservationId,
        message: err?.message,
        responseStatus: err?.response?.status,
        responseData: err?.response?.data,
      });
      throw err;
    }
  },
};