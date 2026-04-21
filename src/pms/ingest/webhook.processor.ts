import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { getAdapter } from "../adapters";
import type { CanonicalReservation } from "../adapters/types";
import { fromZonedTime } from "date-fns-tz";

const prisma = new PrismaClient();

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

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function applyPropertyTime(
  dateStr: string,
  timeStr: string | null | undefined,
  timezone: string
) {
  if (!dateStr) return new Date();

  if (!isDateOnly(dateStr)) {
    return new Date(dateStr);
  }

  const safeTime =
    typeof timeStr === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeStr)
      ? timeStr
      : "16:00";

  const [hours, minutes] = safeTime.split(":").map(Number);

  const localDateTime = `${dateStr.trim()}T${String(hours).padStart(2, "0")}:${String(
    minutes
  ).padStart(2, "0")}:00`;

  return fromZonedTime(localDateTime, timezone);
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
  select: { checkInTime: true, timezone: true },
});
     
  const propertyTimeZone = property?.timezone ?? "America/Puerto_Rico";

const resolvedCheckIn = applyPropertyTime(
  canonical!.checkIn,
  property?.checkInTime ?? "15:00",
  propertyTimeZone
);
     
const resolvedCheckOut = applyPropertyTime(
  canonical!.checkOut,
  "11:00",
  propertyTimeZone
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
    status: reservationStatus, // 🔥 FIX
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
    status: reservationStatus, // 🔥 FIX
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