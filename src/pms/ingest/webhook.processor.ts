import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { getAdapter } from "../adapters";
import type { CanonicalReservation } from "../adapters/types";

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
        connection: { credentialsEncrypted: conn.credentialsEncrypted, metadata: conn.metadata },
        externalReservationId: parsed.externalReservationId,
      });
    }

    if (!canonical) throw new Error("NO_RESERVATION_DATA");

    const canonicalHash = safeJsonHash({
      status: canonical.status,
      checkIn: canonical.checkIn,
      checkOut: canonical.checkOut,
      guest: canonical.guest,
      notes: canonical.notes,
      listingName: (canonical as any).listingName ?? null,
    });

    const ingestKey = `PMS:${String(ev.provider)}:${conn.id}:${canonical.externalReservationId}`;

    const result = await prisma.$transaction(async (tx) => {
      // 0) Idempotency guard (dentro del tx)
      const existingLink = await tx.pmsReservationLink.findUnique({
        where: {
          connectionId_externalReservationId: {
            connectionId: conn.id,
            externalReservationId: canonical!.externalReservationId,
          },
        },
      });

      if (existingLink?.canonicalHash === canonicalHash) {
        return { skipped: true, reservationId: existingLink.reservationId };
      }

      // 1) Lazy create/update listing
      const listingName = (canonical as any).listingName ?? null;

      let listing = await tx.pmsListing.upsert({
        where: {
          connectionId_externalListingId: {
            connectionId: conn.id,
            externalListingId: canonical!.externalListingId,
          },
        },
        create: {
          connectionId: conn.id,
          externalListingId: canonical!.externalListingId,
          name: listingName,
          metadata: canonical as any,
        },
        update: {
          name: listingName ?? undefined,
          metadata: canonical as any,
        },
      });

      // 2) Auto-map A+B
      if (!listing.propertyId) {
        const props = await tx.property.findMany({
          where: { organizationId: conn.organizationId },
          select: { id: true, name: true },
          take: 50,
        });

        if (props.length === 1) {
          listing = await tx.pmsListing.update({
            where: { id: listing.id },
            data: { propertyId: props[0].id },
          });
        } else if (listingName) {
          const target = normalizeName(String(listingName));

          const exact = props.find((p) => normalizeName(p.name) === target);
          if (exact) {
            listing = await tx.pmsListing.update({
              where: { id: listing.id },
              data: { propertyId: exact.id },
            });
          } else {
            const contains = props.filter((p) => {
              const pn = normalizeName(p.name);
              return pn && (pn.includes(target) || target.includes(pn));
            });

            if (contains.length === 1) {
              listing = await tx.pmsListing.update({
                where: { id: listing.id },
                data: { propertyId: contains[0].id },
              });
            }
          }
        }
      }

      // 3) Fail loud if still unmapped
      if (!listing.propertyId) {
        throw new Error(`LISTING_NEEDS_MAPPING:${canonical!.externalListingId}`);
      }

      // 4) Upsert Reservation
      const guestName = (canonical!.guest?.name ?? "").trim() || "Guest";

      const reservationData = {
        propertyId: listing.propertyId,
        guestName,
        guestEmail: canonical!.guest?.email ?? null,
        guestPhone: canonical!.guest?.phone ?? null,
        roomName: listing.name ?? null,
        checkIn: new Date(canonical!.checkIn),
        checkOut: new Date(canonical!.checkOut),
        ingestKey,
        source: String(ev.provider),
      };

      const reservation = await tx.reservation.upsert({
        where: { ingestKey },
        create: reservationData,
        update: reservationData,
      });

      // 4.5) Cancelled => revoke grants + upsert link + return
      if (canonical!.status === "CANCELLED") {
        await tx.accessGrant.updateMany({
          where: {
            reservationId: reservation.id,
            status: { in: ["PENDING", "ACTIVE"] as any },
          },
          data: {
            status: "REVOKED" as any,
            lastError: "CANCELLED_BY_PMS",
          },
        });

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

        return { reservationId: reservation.id, cancelled: true };
      }

      // 5) Upsert link normal
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

      return { reservationId: reservation.id };
    });

    await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });

    console.log("[pms] processed", { eventId: ev.id, reservationId: result.reservationId, skipped: (result as any).skipped });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    const updated = await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: { status: "FAILED", lastError: msg },
    });

    if (updated.attempts >= 10) {
      await prisma.webhookEventIngest.update({
        where: { id: ev.id },
        data: { status: "DEAD" },
      });
    }

    console.error("[pms] failed", { eventId: ev.id, err: msg });
  }
}