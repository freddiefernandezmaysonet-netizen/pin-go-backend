import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

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
  const addressParts = [
    input.address1,
    input.city,
    input.region,
    input.country,
  ]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);

  const address = addressParts.length > 0 ? addressParts.join(", ") : null;

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
      mapsLink: `https://www.google.com/maps?q=${lat},${lng}`,
    };
  }

  // ✅ fallback address (aunque no esté perfecto)
  if (address) {
    return {
      address,
      mapsLink: `https://www.google.com/maps?q=${encodeURIComponent(address)}`,
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
}) {
  const guestName = String(input.guestName ?? "").trim();
  const greetingEs = guestName ? `Hola ${guestName},` : "Hola,";
  const greetingEn = guestName ? `Hi ${guestName},` : "Hi,";

  let es = `${greetingEs}

Tu check-in en ${input.propertyName} está programado para hoy a las ${input.checkInTime}.`;

  let en = `${greetingEn}

Your check-in at ${input.propertyName} is scheduled for today at ${input.checkInTime}.`;

  if (input.address) {
    es += `

Dirección:
${input.address}`;

    en += `

Address:
${input.address}`;
  }

  if (input.mapsLink) {
    es += `

Ubicación exacta:
${input.mapsLink}`;

    en += `

Exact location:
${input.mapsLink}`;
  }

  es += `

Tu acceso digital será enviado automáticamente al inicio de la ventana de entrada.

Te esperamos.`;

  en += `

Your digital access will be sent automatically at check-in time.

We look forward to your arrival.`;

  return `${es}

---

${en}`;
}

export async function sendPreCheckinSms(
  prisma: PrismaClient,
  reservationId: string
) {
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
        checkIn: true,
        property: {
          select: {
            id: true,
            organizationId: true,
            name: true,
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

    const { address, mapsLink } = buildGoogleMapsLink({
      latitude: r.property?.latitude,
      longitude: r.property?.longitude,
      address1: r.property?.address1,
      city: r.property?.city,
      region: r.property?.region,
      country: r.property?.country,
    });

    const checkInTime = new Date(r.checkIn).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const body = buildPreCheckinMessage({
      guestName: r.guestName,
      propertyName,
      checkInTime,
      address,
      mapsLink,
    });

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
            body: "[PRECHECKIN SMS FAILED BEFORE LOG BODY COULD BE PERSISTED]",
            provider: "twilio",
            providerMessageId: null,
            status: "FAILED",
            error: e?.message ?? "unknown_error",
            reservationId: r.id,
            propertyId: r.property?.id ?? null,
            organizationId: r.property?.organizationId ?? null,
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