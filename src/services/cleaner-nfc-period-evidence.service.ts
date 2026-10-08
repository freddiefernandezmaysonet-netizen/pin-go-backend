import { ttlockListCards } from "../ttlock/ttlock.card";

export type CleanerCardPeriodEvidence = {
  status: "REPORTED" | "NOT_LISTED" | "AMBIGUOUS" | "UNVERIFIED";
  physicalAccessVerified: false;
  startsAt?: Date;
  endsAt?: Date;
  periodState?: "FUTURE" | "IN_WINDOW" | "EXPIRED";
};

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Read provider inventory for an exact recorded command target.
 * This is cloud evidence, not physical lock acknowledgement or withdrawal. */
export async function readCleanerCardPeriodEvidence(input: {
  lockId: number;
  cardId: number;
  accessToken: string;
  now: Date;
}, dependencies = { listCards: ttlockListCards }): Promise<CleanerCardPeriodEvidence> {
  const unverified: CleanerCardPeriodEvidence = { status: "UNVERIFIED", physicalAccessVerified: false };
  if (!positiveInteger(input.lockId) || !positiveInteger(input.cardId) ||
      !input.accessToken || !Number.isFinite(input.now.getTime())) return unverified;
  const matching: Record<string, unknown>[] = [];
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const result: unknown = await dependencies.listCards({
      lockId: input.lockId, accessToken: input.accessToken, pageNo, pageSize: 100,
    });
    if (!result || typeof result !== "object" || !("list" in result) ||
        !Array.isArray(result.list)) return unverified;
    const rows = result.list as unknown[];
    if (rows.length > 100) return unverified;
    for (const item of rows) {
      if (!item || typeof item !== "object") return unverified;
      const row = item as Record<string, unknown>;
      const cardId = positiveInteger(row.cardId);
      if (!cardId) return unverified;
      if (cardId !== input.cardId) continue;
      if (positiveInteger(row.lockId) !== input.lockId) return unverified;
      matching.push(row);
      if (matching.length > 1) return { status: "AMBIGUOUS", physicalAccessVerified: false };
    }
    if (rows.length === 100) continue;
    const row = matching[0];
    if (!row) return { status: "NOT_LISTED", physicalAccessVerified: false };
    const start = positiveInteger(row.startDate), end = positiveInteger(row.endDate);
    if (!start || !end || end <= start || !Number.isFinite(new Date(end).getTime()) ||
        !Number.isFinite(new Date(start).getTime())) return unverified;
    // Documented status values concern NB-IoT; do not use them as a gateway
    // acknowledgement. A non-normal status is conservatively unresolved.
    if (row.status !== undefined && Number(row.status) !== 1 && Number(row.status) !== 2) return unverified;
    return { status: "REPORTED", physicalAccessVerified: false,
      startsAt: new Date(start), endsAt: new Date(end),
      periodState: input.now.getTime() < start ? "FUTURE" : input.now.getTime() >= end ? "EXPIRED" : "IN_WINDOW" };
  }
  // The scan bound is not evidence of absence, even if a candidate was seen.
  return unverified;
}
