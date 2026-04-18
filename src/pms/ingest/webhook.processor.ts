import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { getAdapter } from "../adapters";
import type { CanonicalReservation } from "../adapters/types";

const prisma = new PrismaClient();

const DEFAULT_PROPERTY_TIMEZONE = "America/Puerto_Rico";
const DEFAULT_CHECKIN_TIME = "15:00";
const DEFAULT_CHECKOUT_TIME = "11:00";

const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function safeJsonHash(obj: any) {
  return sha256(JSON.stringify(obj ?? {}));
}

function normalizePmsStatus(status: unknown) {
  return String(status ?? "").trim().toUpperCase();
}

function isConfirmedStatus(status: string) {
  return ["CONFIRMED", "BOOKED", "RESERVED", "NEW", "MODIFIED"].includes(status);
}

function isCancelledStatus(status: string) {
  return ["CANCELLED", "CANCELED"].includes(status);
}

function isCheckedOutStatus(status: string) {
  return ["CHECKED_OUT", "CHECKEDOUT", "COMPLETED", "COMPLETE", "FINISHED"].includes(status);
}

function isValidTimeString(value?: string | null): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function extractDatePart(dateStr: string, timezone: string) {
  const raw = String(dateStr ?? "").trim();
  if (!raw) {
    throw new Error("INVALID_DATE_STRING_EMPTY");
  }

  // Caso ideal: YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss...
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) {
    return `${direct[1]}-${direct[2]}-${direct[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`INVALID_DATE_STRING:${raw}`);
  }

  return formatDateInTimeZone(parsed, timezone);
}

function formatDateInTimeZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getZonedDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Convierte una fecha calendario + hora local de negocio + timezone
 * en un instante UTC estable, sin depender del timezone del servidor.
 */
function buildDateAtPropertyTime(
  datePart: string,
  timeStr: string,
  timezone: string
) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!dateMatch) {
    throw new Error(`INVALID_DATE_PART:${datePart}`);
  }

  if (!isValidTimeString(timeStr)) {
    throw new Error(`INVALID_TIME_STRING:${timeStr}`);
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  const [hour, minute] = timeStr.split(":").map(Number);

  // Primer intento: tratar la fecha/hora local como si fuera UTC
  let guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Ajuste iterativo para encontrar el UTC real que representa
  // esa fecha/hora local en la timezone deseada.
  for (let i = 0; i < 2; i += 1) {
    const zoned = getZonedDateTimeParts(new Date(guessUtcMs), timezone);

    const desiredAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const actualAsUtcMs = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      0
    );

    const diffMs = desiredAsUtcMs - actualAsUtcMs;
    guessUtcMs += diffMs;

    if (diffMs === 0) break;
  }

  return new Date(guessUtcMs);
}

/**
 * Regla estable:
 * - siempre toma la fecha calendario del payload PMS
 * - siempre aplica la hora de negocio indicada
 * - siempre usa la timezone de la propiedad
 * - nunca depende del timezone local del servidor
 */
function applyPropertyTime(
  dateStr: string,
  timeStr: string | null | undefined,
  timezone: string,
  fallbackTime: string
) {
  const safeTimezone =
    typeof timezone === "string" && timezone.trim()
      ? timezone.trim()
      : DEFAULT_PROPERTY_TIMEZONE;

  const safeTime = isValidTimeString(timeStr) ? timeStr : fallbackTime;
  const datePart = extractDatePart(dateStr, safeTimezone);

  return buildDateAtPropertyTime(datePart, safeTime, safeTimezone);
}

export async function processWebhookEventById(eventId: string) {
  const ev = await prisma.webhookEventIngest.findUnique({ where: { id: eventId } });
  if (!ev) return;

  if (ev.status === "PROCESSED" || ev.status === "PROCESSING") return;

  await prisma.webhookEventIngest.update({
    where: { id: ev.id },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });

  try {
    const conn = await prisma.pmsConnection.findUnique({ where: { id: ev.connectionId } });
    if (!conn) throw new Error("CONNECTION_NOT_FOUND");
    if (conn.status !== "ACTIVE") throw new Error(`CONNECTION_NOT_ACTIVE:${conn.status}`);

    const adapter = getAdapter(ev.provider as any);
    const parsed = adapter.parseWebhook({ headers: {}, body: ev.payloadRaw });

    let canonical: CanonicalReservation | null = (parsed.reservation as any) ?? null;

    if (!canonical && parsed.externalReservationId && adapter.fetchReservation) {
      canonical = await adapter.fetchReservation({
        connection: {
          id: conn.id,
          credentialsEncrypted: conn.credentialsEncrypted,
          metadata: conn.metadata,
        } as any,
        externalReservationId: parsed.externalReservationId,
      });
    }

    if (!canonical) throw new Error("NO_RESERVATION_DATA");

    const normalizedStatus = normalizePmsStatus(canonical.status);

    const canonicalHash = safeJsonHash({
      status: canonical.status,
      checkIn: canonical.checkIn,
      checkOut: canonical.checkOut,
      guest: canonical.guest,
      notes: canonical.notes,
      listingName: (canonical as any).listingName ?? null,
    });

    const ingestKey = `PMS:${String(ev.provider)}:${conn.id}:${canonical.externalReservationId}`;
    const listingName = (canonical as any).listingName ?? null;

    // 1) Listing
    let listing = await prisma.pmsListing.upsert({
      where: {
        connectionId_externalListingId: {
          connectionId: conn.id,
          externalListingId: canonical.externalListingId,
        },
      },
      create: {
        connectionId: conn.id,
        externalListingId: canonical.externalListingId,
        name: listingName,
        metadata: canonical as any,
      },
      update: {
        name: listingName ?? undefined,
        metadata: canonical as any,
      },
    });

    // 2) Auto-map
    if (!listing.propertyId) {
      const props = await prisma.property.findMany({
        where: { organizationId: conn.organizationId },
        select: { id: true, name: true },
        take: 50,
      });

      if (props.length === 1) {
        listing = await prisma.pmsListing.update({
          where: { id: listing.id },
          data: { propertyId: props[0].id },
        });
      } else if (listingName) {
        const target = normalizeName(String(listingName));

        const exact = props.find((p) => normalizeName(p.name) === target);
        if (exact) {
          listing = await prisma.pmsListing.update({
            where: { id: listing.id },
            data: { propertyId: exact.id },
          });
        }
      }
    }

    if (!listing.propertyId) {
      throw new Error(`LISTING_NEEDS_MAPPING:${canonical.externalListingId}`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const existingLink = await tx.pmsReservationLink.findUnique({
        where: {
          connectionId_externalReservationId: {
            connectionId: conn.id,
            externalReservationId: canonical!.externalReservationId,
          },
        },
      });

      if (existingLink?.canonicalHash === canonicalHash) {
        return {
          skipped: true,
          reservationId: existingLink.reservationId,
        };
      }

      const property = await tx.property.findUnique({
        where: { id: listing.propertyId! },
        select: {
          checkInTime: true,
          timezone: true,
        },
      });

      const propertyTimezone =
        property?.timezone?.trim() || DEFAULT_PROPERTY_TIMEZONE;

      const resolvedCheckIn = applyPropertyTime(
        canonical!.checkIn,
        property?.checkInTime ?? DEFAULT_CHECKIN_TIME,
        propertyTimezone,
        DEFAULT_CHECKIN_TIME
      );

      const resolvedCheckOut = applyPropertyTime(
        canonical!.checkOut,
        DEFAULT_CHECKOUT_TIME,
        propertyTimezone,
        DEFAULT_CHECKOUT_TIME
      );

      const reservationStatus =
        isCancelledStatus(normalizedStatus)
          ? "CANCELLED"
          : "ACTIVE";

      const reservation = await tx.reservation.upsert({
        where: { ingestKey },
        create: {
          propertyId: listing.propertyId!,
          guestName: canonical!.guest?.name ?? "Guest",
          guestEmail: canonical!.guest?.email ?? null,
          guestPhone: canonical!.guest?.phone ?? null,
          roomName: listing.name ?? null,
          checkIn: resolvedCheckIn,
          checkOut: resolvedCheckOut,
          status: reservationStatus,
          ingestKey,
          source: String(ev.provider),
        },
        update: {
          propertyId: listing.propertyId!,
          guestName: canonical!.guest?.name ?? "Guest",
          guestEmail: canonical!.guest?.email ?? null,
          guestPhone: canonical!.guest?.phone ?? null,
          roomName: listing.name ?? null,
          checkIn: resolvedCheckIn,
          checkOut: resolvedCheckOut,
          status: reservationStatus,
          ingestKey,
          source: String(ev.provider),
        },
      });

      // ACCESS GRANT (CREATE + UPDATE)
      const existingGrant = await tx.accessGrant.findFirst({
        where: {
          reservationId: reservation.id,
          status: { in: ["PENDING", "ACTIVE"] as any },
        },
      });

      if (isConfirmedStatus(normalizedStatus)) {
        const lock = await tx.lock.findFirst({
          where: {
            propertyId: listing.propertyId!,
            isActive: true,
          },
        });

        if (lock) {
          if (!existingGrant) {
            await tx.accessGrant.create({
              data: {
                reservationId: reservation.id,
                lockId: lock.id,
                startsAt: resolvedCheckIn,
                endsAt: resolvedCheckOut,
                status: "PENDING",
                method: "PASSCODE_TIMEBOUND",
                type: "GUEST",
              },
            });
          } else {
            const needsUpdate =
              existingGrant.startsAt.getTime() !== resolvedCheckIn.getTime() ||
              existingGrant.endsAt.getTime() !== resolvedCheckOut.getTime();

            if (needsUpdate) {
              await tx.accessGrant.update({
                where: { id: existingGrant.id },
                data: {
                  startsAt: resolvedCheckIn,
                  endsAt: resolvedCheckOut,
                },
              });
            }
          }
        }
      }

      if (isCancelledStatus(normalizedStatus)) {
        await tx.accessGrant.updateMany({
          where: {
            reservationId: reservation.id,
            status: { in: ["PENDING", "ACTIVE"] as any },
          },
          data: { status: "REVOKED" },
        });

        return {
          reservationId: reservation.id,
          cancelled: true,
        };
      }

      if (isCheckedOutStatus(normalizedStatus)) {
        await tx.accessGrant.updateMany({
          where: {
            reservationId: reservation.id,
            status: { in: ["PENDING", "ACTIVE"] as any },
          },
          data: { status: "REVOKED" },
        });
      }

      await tx.pmsReservationLink.upsert({
        where: {
          connectionId_externalReservationId: {
            connectionId: conn.id,
            externalReservationId: canonical!.externalReservationId,
          },
        },
        create: {
          connectionId: conn.id,
          externalReservationId: canonical!.externalReservationId,
          reservationId: reservation.id,
          canonicalHash,
        },
        update: {
          reservationId: reservation.id,
          canonicalHash,
          lastSeenAt: new Date(),
        },
      });

      return {
        reservationId: reservation.id,
      };
    });

    await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });

    console.log("[pms] processed", {
      eventId: ev.id,
      reservationId: (result as any).reservationId,
      skipped: (result as any).skipped,
      normalizedStatus,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: { status: "FAILED", lastError: msg },
    });

    console.error("[pms] failed", { eventId: ev.id, err: msg });
  }
}