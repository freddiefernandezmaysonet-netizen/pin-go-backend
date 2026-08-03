import type { Prisma } from "@prisma/client";

import {
  CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
  CHANNEX_ARI_MAX_SELECTION_LIMIT,
  selectChannexAriDispatchJobs,
} from "./channex-ari-job-selection.policy";
import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_DEFAULT_SELECTION_SCAN_MULTIPLIER = 10;
export const CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT = 1000;

type ChannexAriJobSelectionDb = Pick<
  Prisma.TransactionClient,
  "channexAriDelivery" | "channexAriPropertyState"
>;

export type ReadChannexAriDispatchSelectionInput = {
  now?: Date;
  limit?: number;
  candidateScanLimit?: number;
};

function assertValidNow(value?: Date): Date {
  const now = value ? new Date(value) : new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error("CHANNEX_ARI_SELECTION_NOW_INVALID");
  }

  return now;
}

function normalizeSelectionLimit(value?: number): number {
  const limit =
    value === undefined ? CHANNEX_ARI_DEFAULT_SELECTION_LIMIT : Number(value);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CHANNEX_ARI_MAX_SELECTION_LIMIT
  ) {
    throw new Error("CHANNEX_ARI_SELECTION_LIMIT_INVALID");
  }

  return limit;
}

function normalizeCandidateScanLimit(input: {
  value?: number;
  selectionLimit: number;
}): number {
  const defaultScanLimit = Math.min(
    CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT,
    input.selectionLimit * CHANNEX_ARI_DEFAULT_SELECTION_SCAN_MULTIPLIER
  );
  const scanLimit =
    input.value === undefined ? defaultScanLimit : Number(input.value);

  if (
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < input.selectionLimit ||
    scanLimit > CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT
  ) {
    throw new Error("CHANNEX_ARI_SELECTION_SCAN_LIMIT_INVALID");
  }

  return scanLimit;
}

const candidateSelect = {
  id: true,
  organizationId: true,
  propertyId: true,
  messageKind: true,
  status: true,
  attemptCount: true,
  nextAttemptAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  queuedAt: true,
  createdAt: true,
} as const;

export async function readChannexAriDispatchSelection(
  db: ChannexAriJobSelectionDb,
  input: ReadChannexAriDispatchSelectionInput = {}
) {
  const now = assertValidNow(input.now);
  const limit = normalizeSelectionLimit(input.limit);
  const candidateScanLimit = normalizeCandidateScanLimit({
    value: input.candidateScanLimit,
    selectionLimit: limit,
  });

  const [staleCandidates, claimCandidates] = await Promise.all([
    db.channexAriDelivery.findMany({
      where: {
        status: "PROCESSING",
        leaseToken: { not: null },
        leaseExpiresAt: { lte: now },
      },
      orderBy: [
        { leaseExpiresAt: "asc" },
        { queuedAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: candidateScanLimit,
      select: candidateSelect,
    }),
    db.channexAriDelivery.findMany({
      where: {
        status: { in: ["READY", "RETRY_WAIT"] },
        attemptCount: { lt: CHANNEX_ARI_MAX_ATTEMPTS },
        OR: [
          { nextAttemptAt: null },
          { nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: [
        { nextAttemptAt: "asc" },
        { queuedAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: candidateScanLimit,
      select: candidateSelect,
    }),
  ]);

  const candidateById = new Map<string, (typeof staleCandidates)[number]>();

  for (const candidate of [...staleCandidates, ...claimCandidates]) {
    candidateById.set(candidate.id, candidate);
  }

  const candidates = Array.from(candidateById.values());
  const propertyIds = Array.from(
    new Set(candidates.map((candidate) => candidate.propertyId))
  );
  const propertyStates =
    propertyIds.length === 0
      ? []
      : await db.channexAriPropertyState.findMany({
          where: {
            propertyId: { in: propertyIds },
          },
          orderBy: [{ propertyId: "asc" }],
          select: {
            propertyId: true,
            organizationId: true,
            pausedUntil: true,
            availabilityNextAllowedAt: true,
            ratesNextAllowedAt: true,
          },
        });

  const selection = selectChannexAriDispatchJobs({
    candidates,
    propertyStates,
    now,
    limit,
  });

  return {
    ...selection,
    query: {
      candidateScanLimit,
      staleCandidateCount: staleCandidates.length,
      claimCandidateCount: claimCandidates.length,
      uniqueCandidateCount: candidates.length,
      propertyStateCount: propertyStates.length,
    },
  };
}
