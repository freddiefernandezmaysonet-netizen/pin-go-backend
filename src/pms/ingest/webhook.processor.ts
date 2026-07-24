import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { getAdapter } from "../adapters";
import type { CanonicalReservation } from "../adapters/types";
import { fromZonedTime } from "date-fns-tz";
import { selectNextStaffForProperty } from "../../services/staff-selection.service";
import { createCleaningConfirmation } from "../../services/cleaning-confirmation.service";
import { reconcileReservation } from "../../services/reservation.reconcile.service";

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

   const rawPayload = ev.payloadRaw as any;

const rawCanonicalForHash = (canonical as any).raw ?? {};

const canonicalHash = safeJsonHash({
  status: canonical.status,
  checkIn: canonical.checkIn,
  checkOut: canonical.checkOut,
  guest: canonical.guest,
  notes: canonical.notes,
  listingName: (canonical as any).listingName ?? null,

  // payment/source-sensitive fields
  ota_name: rawCanonicalForHash?.ota_name ?? null,
  payment_collect: rawCanonicalForHash?.payment_collect ?? null,
  amount: rawCanonicalForHash?.amount ?? null,

  // legacy payment fields
  amount_paid: rawPayload?.amount_paid ?? null,
  amount_due: rawPayload?.amount_due ?? null,
  total_amount: rawPayload?.total_amount ?? null,
  transactions: rawPayload?.transactions ?? null,
});
    const ingestKey = `PMS:${String(ev.provider)}:${conn.id}:${canonical.externalReservationId}`;
    const listingName = (canonical as any).listingName ?? null;

        // 1) Listing
    let listing = await prisma.pmsListing.findUnique({
      where: {
        connectionId_externalListingId: {
          connectionId: conn.id,
          externalListingId: canonical.externalListingId,
        },
      },
    });

    if (!listing && String(ev.provider) === "CHANNEX") {
      listing = await prisma.pmsListing.findFirst({
        where: {
          connectionId: conn.id,
          metadata: {
            path: ["channexPropertyId"],
            equals: canonical.externalListingId,
          },
        },
      });
    }

    if (!listing) {
      listing = await prisma.pmsListing.create({
        data: {
          connectionId: conn.id,
          externalListingId: canonical.externalListingId,
          name: listingName,
          metadata: canonical as any,
        },
      });
    } else {
      listing = await prisma.pmsListing.update({
        where: { id: listing.id },
        data: {
          name: listingName ?? listing.name,
          metadata: {
            ...(typeof listing.metadata === "object" && listing.metadata
              ? (listing.metadata as any)
              : {}),
            lastCanonicalReservation: canonical as any,
          },
        },
      });
    }
   
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

const raw = ev.payloadRaw ?? {};
const rawCanonical = (canonical as any).raw ?? {};
const reservationAmount =
  Number(rawCanonical?.amount ?? 0) > 0
    ? Number(rawCanonical.amount)
    : null;

const otaName = String(rawCanonical?.ota_name ?? "").trim();

const reservationSource =
  String(ev.provider) === "CHANNEX" && otaName.length > 0
    ? otaName
    : String(ev.provider);

let paymentState: "PAID" | "NONE" = "NONE";

if (String(ev.provider) === "CHANNEX") {
  const paymentCollect = String(rawCanonical?.payment_collect ?? "").toLowerCase();
  const amount = Number(rawCanonical?.amount ?? 0);

  if (paymentCollect === "ota" && amount > 0) {
    paymentState = "PAID";
  }
} else {
  const amountPaid = Number((raw as any)?.amount_paid ?? 0);
  const total = Number((raw as any)?.total_amount ?? 0);

  if (total > 0 && amountPaid >= total) {
    paymentState = "PAID";
  }
}
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
    source: reservationSource,
    paymentState,
    externalId: canonical!.externalReservationId,
    externalProvider: String(ev.provider),
    totalAmount: reservationAmount,
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
    source: reservationSource,
    paymentState,
    externalId: canonical!.externalReservationId,
    externalProvider: String(ev.provider),
    totalAmount: reservationAmount,
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
let cleaningConfirmation: {
  reservationId: string;
  propertyId: string;
  staffMemberId: string;
} | null = null;

try {
  const existingConfirmedCleaning =
    await tx.cleaningConfirmation.findFirst({
      where: {
        reservationId: reservation.id,
        status: "CONFIRMED",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

  let staff = null;

  if (existingConfirmedCleaning) {
    staff = await tx.staffMember.findUnique({
      where: {
        id: existingConfirmedCleaning.staffMemberId,
      },
    });

    console.log("[PMS_CLEANING_RECONFIRM]", {
      reservationId: reservation.id,
      existingStaffId:
        existingConfirmedCleaning.staffMemberId,
    });
  } else {
    staff = await selectNextStaffForProperty({
      propertyId: listing.propertyId!,
    });
  }

  console.log("[PMS_CLEANING_STAFF]", {
    reservationId: reservation.id,
    propertyId: listing.propertyId!,
    staffId: staff?.id ?? null,
    phone: staff?.phoneE164 ?? null,
  });

  if (staff) {
    const existingPending =
      await tx.cleaningConfirmation.findFirst({
        where: {
          reservationId: reservation.id,
          staffMemberId: staff.id,
          status: "PENDING",
        },
      });

    if (!existingPending) {
      cleaningConfirmation = {
        reservationId: reservation.id,
        propertyId: listing.propertyId!,
        staffMemberId: staff.id,
      };
    }
  }
} catch (e) {
  console.error("[PMS_CLEANING_SELECT_ERROR]", e);
}
  
return {
  reservationId: reservation.id,
  cleaningConfirmation,
};
     
    });

    await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });

console.log("[PMS_CLEANING_RESULT]", {
  reservationId: (result as any).reservationId,
  cleaningConfirmation: (result as any).cleaningConfirmation ?? null,
});

if ((result as any).cleaningConfirmation) {
  await createCleaningConfirmation(
    (result as any).cleaningConfirmation
  );
}

 if ((result as any).reservationId) {
  console.log("[PMS][RECONCILE_TRIGGER]", {
    reservationId: (result as any).reservationId,
    skipped: (result as any).skipped,
  });

  await reconcileReservation(
    (result as any).reservationId
  );
}   
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
