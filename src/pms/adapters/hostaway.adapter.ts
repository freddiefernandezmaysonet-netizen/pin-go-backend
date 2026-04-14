import type { PmsAdapter, CanonicalReservation } from "./types";
import axios from "axios";
import crypto from "crypto";

const HOSTAWAY_BASE_URL = "https://api.hostaway.com/v1";
const HOSTAWAY_AUTH_URL = "https://api.hostaway.com/v1/accessTokens";

type HostawayCredentials = {
  accessToken?: string | null;
  accountId?: string | null;
  apiKey?: string | null;
};

type HostawayTokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

const hostawayTokenCache = new Map<string, HostawayTokenCacheEntry>();

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
    throw new Error("HOSTAWAY_NO_CREDENTIALS");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HOSTAWAY_BAD_CREDENTIALS_JSON");
  }

  // Compatibilidad hacia atrás:
  // si ya viene como JSON plano con accessToken/accountId/apiKey
  if (
    parsed &&
    !parsed.alg &&
    !parsed.iv &&
    !parsed.tag &&
    !parsed.data
  ) {
    return JSON.stringify(parsed);
  }

  // Formato cifrado AES-256-GCM
  if (
    parsed?.alg !== "aes-256-gcm" ||
    !parsed?.iv ||
    !parsed?.tag ||
    !parsed?.data
  ) {
    throw new Error("HOSTAWAY_BAD_CREDENTIALS_FORMAT");
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

function parseCredentials(connection: { credentialsEncrypted?: string | null }): HostawayCredentials {
  if (!connection.credentialsEncrypted) {
    throw new Error("HOSTAWAY_NO_CREDENTIALS");
  }

  let creds: any;
  try {
    const decryptedJson = decryptCredentialsIfNeeded(connection.credentialsEncrypted);
    creds = JSON.parse(decryptedJson);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (
      msg === "HOSTAWAY_NO_CREDENTIALS" ||
      msg === "HOSTAWAY_BAD_CREDENTIALS_JSON" ||
      msg === "HOSTAWAY_BAD_CREDENTIALS_FORMAT" ||
      msg === "PMS_CREDENTIALS_SECRET not configured"
    ) {
      throw err;
    }
    throw new Error("HOSTAWAY_CREDENTIALS_DECRYPT_FAILED");
  }

  return {
    accessToken: creds?.accessToken ? String(creds.accessToken) : null,
    accountId: creds?.accountId ? String(creds.accountId) : null,
    apiKey: creds?.apiKey ? String(creds.apiKey) : null,
  };
}

/**
 * Compatibilidad hacia atrás:
 * - Si una conexión vieja ya tiene accessToken guardado, lo usamos.
 * - Si la conexión nueva tiene accountId/apiKey, pedimos token real.
 */
async function getAccessTokenOrThrow(connection: {
  id?: string | null;
  credentialsEncrypted?: string | null;
}) {
  const creds = parseCredentials(connection);

  if (creds.accessToken) {
    return creds.accessToken;
  }

  if (!creds.accountId || !creds.apiKey) {
    throw new Error("HOSTAWAY_MISSING_ACCOUNT_OR_API_KEY");
  }

  const cacheKey = String(connection.id ?? `${creds.accountId}:hostaway`);
  const cached = hostawayTokenCache.get(cacheKey);

  // Hostaway dice que el token puede durar hasta 24 meses; aun así cacheamos
  // en memoria y lo reutilizamos mientras exista este proceso. :contentReference[oaicite:1]{index=1}
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const resp = await axios.post(
    HOSTAWAY_AUTH_URL,
    {
      grant_type: "client_credentials",
      client_id: creds.accountId,
      client_secret: creds.apiKey,
      scope: "general",
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  const accessToken =
    resp.data?.access_token ??
    resp.data?.token ??
    resp.data?.data?.access_token ??
    null;

  if (!accessToken) {
    throw new Error("HOSTAWAY_TOKEN_RESPONSE_INVALID");
  }

  // Como Hostaway permite tokens largos, usamos un TTL conservador en memoria.
  // Esto evita pedir token en cada request aunque reinicies proceso se regenerará. :contentReference[oaicite:2]{index=2}
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  hostawayTokenCache.set(cacheKey, {
    accessToken: String(accessToken),
    expiresAt,
  });

  return String(accessToken);
}

function mapHostawayReservationToCanonical(
  externalReservationId: string,
  r: any
): CanonicalReservation {
  const externalListingId =
    r?.listingId ??
    r?.listing_id ??
    r?.propertyId ??
    r?.property_id ??
    r?.listingMapId ??
    r?.listing?.id ??
    r?.property?._id ??
    r?.property?.id;

  const checkInRaw =
    r?.checkIn ??
    r?.checkInDate ??
    r?.arrivalDate ??
    r?.arrival ??
    r?.startDate;

  const checkOutRaw =
    r?.checkOut ??
    r?.checkOutDate ??
    r?.departureDate ??
    r?.departure ??
    r?.endDate;

  const guestName =
    r?.guestName ??
    r?.guest?.name ??
    [r?.guest?.firstName, r?.guest?.lastName].filter(Boolean).join(" ") ??
    r?.customerName ??
    null;

  const listingName =
    r?.listingName ??
    r?.propertyName ??
    r?.listing?.name ??
    r?.listing?.title ??
    null;

  const rawStatus = String(r?.status ?? "").toLowerCase();

  const status: CanonicalReservation["status"] =
    ["cancelled", "canceled"].includes(rawStatus)
      ? "CANCELLED"
      : "CONFIRMED";

  if (!externalListingId) {
    throw new Error("HOSTAWAY_RESERVATION_MISSING_LISTING_ID");
  }

  if (!checkInRaw || !checkOutRaw) {
    throw new Error("HOSTAWAY_RESERVATION_MISSING_DATES");
  }

  return {
    provider: "HOSTAWAY",
    externalReservationId: String(externalReservationId),
    externalListingId: String(externalListingId),
    listingName,
    status,
    checkIn: new Date(checkInRaw).toISOString(),
    checkOut: new Date(checkOutRaw).toISOString(),
    guest: {
      name: guestName,
      email: r?.guestEmail ?? r?.guest?.email ?? null,
      phone: r?.guestPhone ?? r?.guest?.phone ?? null,
    },
    notes: r?.notes ?? r?.internalNotes ?? null,
    raw: r,
  };
}

export const hostawayAdapter: PmsAdapter = {
  provider: "HOSTAWAY",

  parseWebhook: ({ body }) => {
    const eventType =
      body?.event ??
      body?.eventType ??
      body?.type ??
      "RESERVATION";

    const externalEventId =
      body?.eventId ??
      body?.id ??
      body?.reservationId ??
      null;

    const externalReservationId =
      body?.reservationId ??
      body?.reservation_id ??
      body?.data?.reservationId ??
      body?.data?.reservation_id ??
      body?.reservation?.id ??
      body?.reservation?._id ??
      null;

    const externalListingId =
      body?.listingId ??
      body?.listing_id ??
      body?.propertyId ??
      body?.property_id ??
      body?.data?.listingId ??
      body?.data?.listing_id ??
      body?.data?.propertyId ??
      body?.data?.property_id ??
      body?.reservation?.listingId ??
      body?.reservation?.propertyId ??
      null;

    if (externalReservationId && externalListingId && body?.checkIn && body?.checkOut) {
      return {
        eventType,
        externalEventId,
        reservation: {
          provider: "HOSTAWAY",
          externalReservationId: String(externalReservationId),
          externalListingId: String(externalListingId),
          listingName:
            body?.listingName ??
            body?.propertyName ??
            body?.data?.listingName ??
            body?.data?.propertyName ??
            null,
          status:
            String(body?.status ?? "").toLowerCase() === "cancelled"
              ? "CANCELLED"
              : "CONFIRMED",
          checkIn: new Date(body.checkIn).toISOString(),
          checkOut: new Date(body.checkOut).toISOString(),
          guest: {
            name: body?.guestName ?? body?.guest?.name ?? null,
            email: body?.guestEmail ?? body?.guest?.email ?? null,
            phone: body?.guestPhone ?? body?.guest?.phone ?? null,
          },
          notes: body?.notes ?? null,
          raw: body,
        },
      };
    }

    return {
      eventType,
      externalEventId,
      externalReservationId: externalReservationId
        ? String(externalReservationId)
        : undefined,
    };
  },

  /**
   * Webhook trae solo reservationId -> fetch real a Hostaway
   */
  fetchReservation: async ({ connection, externalReservationId }) => {
    if (!externalReservationId) {
      throw new Error("HOSTAWAY_MISSING_EXTERNAL_RESERVATION_ID");
    }

    try {
      const accessToken = await getAccessTokenOrThrow(connection);

      const url = `${HOSTAWAY_BASE_URL}/reservations/${encodeURIComponent(
        externalReservationId
      )}`;

      const resp = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        timeout: 15000,
      });

      const payload = resp.data?.result ?? resp.data?.data ?? resp.data;

      return mapHostawayReservationToCanonical(externalReservationId, payload);
    } catch (err: any) {
      console.error("❌ Hostaway fetchReservation error:", {
        externalReservationId,
        message: err?.message,
        responseStatus: err?.response?.status,
        responseData: err?.response?.data,
      });
      throw err;
    }
  },
};