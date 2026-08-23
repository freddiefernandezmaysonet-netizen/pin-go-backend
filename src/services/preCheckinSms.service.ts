import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import { buildGuestLink } from "./guestToken";
import {
  getGuestIntlLocale,
  resolveGuestLanguage,
  type GuestLanguage,
} from "./guest-language.service";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasValidCoordinates(
  latitude: unknown,
  longitude: unknown
): boolean {
  const lat = toNumber(latitude);
  const lng = toNumber(longitude);

  if (lat === null || lng === null) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;

  return true;
}

function buildGoogleMapsLink(input: {
  latitude?: unknown;
  longitude?: unknown;
  address1?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
}): { address: string | null; mapsLink: string | null } {
     const isPuertoRico =
  String(input.region ?? "").toLowerCase().includes("puerto rico") ||
  String(input.country ?? "").toLowerCase() === "puerto rico";

const formattedAddress = String(input.address1 ?? "").trim();

const fallbackAddressParts = [
  input.city,
  input.region,
  isPuertoRico ? null : input.country,
]

    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);

  const address = formattedAddress ||
    (fallbackAddressParts.length > 0 ? fallbackAddressParts.join(", ") : null);

  // 🔧 parsing más tolerante
  const lat =
    input.latitude === null || input.latitude === undefined || input.latitude === ""
      ? null
      : Number(input.latitude);

  const lng =
    input.longitude === null || input.longitude === undefined || input.longitude === ""
      ? null
      : Number(input.longitude);

  const hasCoords =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat! >= -90 &&
    lat! <= 90 &&
    lng! >= -180 &&
    lng! <= 180;

  // ✅ PRIORIDAD: coordenadas SIEMPRE
  if (hasCoords) {
    return {
      address,
  mapsLink: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    };
  }

  // ✅ fallback address (aunque no esté perfecto)
  if (address) {
    return {
      address,
  mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,   
    };
  }

  return {
    address: null,
    mapsLink: null,
  };
}

function buildPreCheckinMessage(input: {
  guestName?: string | null;
  propertyName: string;
  checkInTime: string;
  address: string | null;
  mapsLink: string | null;
  verifyLink: string | null;
  language: GuestLanguage;
}) {
  const guestName = String(input.guestName ?? "").trim();
  const isSpanish = input.language === "es";
  const greeting = guestName
    ? `${isSpanish ? "Hola" : "Hi"} ${guestName},`
    : isSpanish
      ? "Hola,"
      : "Hi,";

  let message = isSpanish
    ? `${greeting}\n\nTu check-in en ${input.propertyName} está programado para hoy a las ${input.checkInTime}.`
    : `${greeting}\n\nYour check-in at ${input.propertyName} is scheduled for today at ${input.checkInTime}.`;

  if (input.address) {
    message += isSpanish
      ? `\n\nDirección:\n${input.address}`
      : `\n\nAddress:\n${input.address}`;
  }

  if (input.mapsLink) {
    message += isSpanish
      ? `\n\nUbicación exacta:\n${input.mapsLink}`
      : `\n\nExact location:\n${input.mapsLink}`;
  }

  if (input.verifyLink) {
    message += isSpanish
      ? `\n\n🛡️ Antes de recibir sus accesos digitales, complete su registro previo al check-in:\n\n${input.verifyLink}`
      : `\n\n🛡️ Before receiving your digital access credentials, please complete your secure pre-check-in verification:\n\n${input.verifyLink}`;
  }

  message += isSpanish
    ? "\n\nTu acceso digital será enviado automáticamente luego de completar la verificación.\n\nTe esperamos."
    : "\n\nYour digital access will be delivered automatically after verification is completed.\n\nWe look forward to your arrival.";

  return message;
}

export async function sendPreCheckinSms(
  prisma: PrismaClient,
  reservationId: string
) {
  let retryBody: string | null = null;
  try {
    const existing = await prisma.messageDispatchLog.findFirst({
      where: {
        reservationId,
        type: "PRECHECKIN",
        status: "SENT",
      },
    });

    if (existing) {
      return { ok: true, skipped: true };
    }

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        guestName: true,
        guestPhone: true,
        preferredLanguage: true,
        guestToken: true,
        checkIn: true,
        property: {
          select: {
            id: true,
            organizationId: true,
            name: true,
            timezone: true,
            address1: true,
            city: true,
            region: true,
            country: true,
            latitude: true,
            longitude: true,
          },
        },
      },
    });

    if (!r || !r.guestPhone) {
      return { ok: false, skipped: true, error: "Missing guestPhone" };
    }

    const propertyName = r.property?.name ?? "your property";

    const verifyLink = r.guestToken
      ? buildGuestLink(r.guestToken).replace("/guest/access/", "/guest/verify/")
      : null;
    
    const { address, mapsLink } = buildGoogleMapsLink({
      latitude: r.property?.latitude,
      longitude: r.property?.longitude,
      address1: r.property?.address1,
      city: r.property?.city,
      region: r.property?.region,
      country: r.property?.country,
    });

    const language = resolveGuestLanguage(r.preferredLanguage);

   const checkInTime = new Intl.DateTimeFormat(getGuestIntlLocale(language), {
  timeZone: r.property?.timezone ?? "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
}).format(new Date(r.checkIn));

    const body = buildPreCheckinMessage({
      guestName: r.guestName,
      propertyName,
      checkInTime,
      address,
      mapsLink,
      verifyLink,
      language,
    });
    retryBody = body;

    const sent = await sendSms(r.guestPhone, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: r.guestPhone,
        from: process.env.TWILIO_FROM_NUMBER ?? null,
        body,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        reservationId: r.id,
        propertyId: r.property?.id ?? null,
        organizationId: r.property?.organizationId ?? null,
        communicationType: "PRECHECKIN",
      },
    });

    await prisma.messageDispatchLog.create({
      data: {
        reservationId: r.id,
        type: "PRECHECKIN",
        channel: "sms",
        status: "SENT",
      },
    });

    return { ok: true };
  } catch (e: any) {
    console.error("[preCheckinSms] failed", e);

    try {
      const r = await prisma.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          guestPhone: true,
          property: {
            select: {
              id: true,
              organizationId: true,
            },
          },
        },
      });

      if (r?.guestPhone) {
        await prisma.messageLog.create({
          data: {
            channel: "sms",
            to: r.guestPhone,
            from: process.env.TWILIO_FROM_NUMBER ?? null,
            body: retryBody ?? "[PRECHECKIN SMS FAILED BEFORE LOG BODY COULD BE PERSISTED]",
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: e?.message ?? "unknown_error",
            reservationId: r.id,
            propertyId: r.property?.id ?? null,
            organizationId: r.property?.organizationId ?? null,
            communicationType: "PRECHECKIN",
          },
        });
      }
    } catch {
      // no bloquear flujo principal
    }

    await prisma.messageDispatchLog.create({
      data: {
        reservationId,
        type: "PRECHECKIN",
        channel: "sms",
        status: "FAILED",
      },
    });

    return { ok: false, error: e?.message ?? "unknown_error" };
  }
}
