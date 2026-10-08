import type { PrismaClient } from "@prisma/client";
import { isOtaGuestExternalDeliveryBlocked } from "../services/ota-guest-external-messaging.policy.js";
import { deliverOtaOperationalCommunication } from "./ota-operational-guest.service.js";

const PAGE_SIZE = 100;
const CONCURRENCY = 4;
const MAX_PAGES = 100;

/**
 * Scan due OTA operational events independently of the guest's phone/email.
 * Re-scan from the beginning each cycle; durable Channex receipts deduplicate.
 * No in-memory cursor advances past failed work.
 */
export async function processOtaOperationalCommunications(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<{ candidates: number; accepted: number; blocked: number }> {
  if (!String(env.OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS ?? "").trim()) {
    return { candidates: 0, accepted: 0, blocked: 0 };
  }

  const fourHours = new Date(now.getTime() + 4 * 3600000);
  const pastHour = new Date(now.getTime() - 3600000);
  let cursor: string | undefined;
  let candidates = 0, accepted = 0, blocked = 0;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await prisma.reservation.findMany({
      where: {
        externalProvider: "CHANNEX", externalId: { not: null },
        status: "ACTIVE", paymentState: "PAID", cancelledAt: null,
        OR: [
          { checkIn: { gt: now, lte: fourHours } },
          {
            guestAccessReleaseStatus: "RELEASED",
            checkIn: { lte: fourHours }, checkOut: { gt: now },
          },
          { checkOut: { gte: pastHour, lte: now } },
        ],
      },
      select: {
        id: true, source: true, externalProvider: true, externalId: true,
        checkIn: true, checkOut: true, guestAccessReleaseStatus: true,
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const eligible = rows.filter(r =>
      isOtaGuestExternalDeliveryBlocked(r, "sms", env) ||
      isOtaGuestExternalDeliveryBlocked(r, "email", env),
    );
    candidates += eligible.length;

    for (let index = 0; index < eligible.length; index += CONCURRENCY) {
      await Promise.all(eligible.slice(index, index + CONCURRENCY).map(async r => {
        const types: Array<"PRECHECKIN" | "GUEST_ACCESS_PASSCODE" | "CHECKOUT"> = [];
        if (r.checkIn > now && r.checkIn <= fourHours) types.push("PRECHECKIN");
        if (r.guestAccessReleaseStatus === "RELEASED" && r.checkOut > now &&
            r.checkIn <= fourHours) types.push("GUEST_ACCESS_PASSCODE");
        if (r.checkOut >= pastHour && r.checkOut <= now) types.push("CHECKOUT");

        for (const type of types) {
          try {
            const result = await deliverOtaOperationalCommunication(
              prisma, r.id, type, { env, now },
            );
            if (result?.ok) accepted++;
            else if (result) {
              blocked++;
              // No credentials, phone, guest message or provider error bodies.
              console.error("[OTA_CHANNEX_OPERATIONAL_BLOCKED]", {
                reservationId: r.id, type, code: result.error ?? "UNKNOWN",
              });
            }
          } catch {
            blocked++;
            console.error("[OTA_CHANNEX_OPERATIONAL_BLOCKED]", {
              reservationId: r.id, type, code: "UNEXPECTED",
            });
          }
        }
      }));
    }

    if (rows.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
    cursor = rows[rows.length - 1]!.id;
  }

  if (!exhausted) {
    // Explicit failure rather than silently starving later reservations.
    throw Error("OTA_CHANNEX_OPERATIONAL_SCAN_PAGE_LIMIT");
  }
  return { candidates, accepted, blocked };
}
