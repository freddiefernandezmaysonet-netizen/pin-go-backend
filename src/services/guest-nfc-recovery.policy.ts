import type { Prisma } from "@prisma/client";

export const GUEST_NFC_MAX_ATTEMPTS = 5;
export const GUEST_NFC_GENERIC_FAILURE = "Error: TTLock errcode=1 errmsg=failed or means no";
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

export function guestNfcRetryable(error: string): boolean {
  return error === GUEST_NFC_GENERIC_FAILURE ||
    error === `RETRYABLE: ${GUEST_NFC_GENERIC_FAILURE}` ||
    /timeout|timed out|econnreset|socket hang up|enotfound|eai_again|gateway|offline|sync|operation was aborted/i.test(error);
}

export function guestNfcNextRetry(attempts: number, updatedAt: Date): Date | null {
  if (attempts >= GUEST_NFC_MAX_ATTEMPTS) return null;
  return new Date(updatedAt.getTime() + RETRY_DELAYS_MS[Math.max(0, attempts - 1)]!);
}

// Include only due rows in SQL, so an exhausted or delayed row cannot starve
// another assignment at the front of a bounded batch.
export function guestNfcDueWhere(now: Date): Prisma.NfcAssignmentWhereInput {
  return {
    role: "GUEST",
    Reservation: { status: "ACTIVE", checkOut: { gt: now },
      checkIn: { lte: new Date(now.getTime() + 2 * 60 * 60_000) } },
    OR: [
      { status: "SCHEDULED", retryCount: { lt: GUEST_NFC_MAX_ATTEMPTS } },
      { status: "FAILED", OR: [
        { lastError: { startsWith: "RETRYABLE:" } },
        { lastError: GUEST_NFC_GENERIC_FAILURE },
      ], AND: [{ OR: RETRY_DELAYS_MS.map((delay, index) => ({
        retryCount: index === 0 ? { lte: 1 } : index + 1,
        updatedAt: { lte: new Date(now.getTime() - delay) },
      })) }] },
      { status: "PROVISIONING", retryCount: { lt: GUEST_NFC_MAX_ATTEMPTS },
        OR: [{ provisioningStartedAt: null },
          { provisioningStartedAt: { lte: new Date(now.getTime() - 5 * 60_000) } }] },
    ],
  };
}
