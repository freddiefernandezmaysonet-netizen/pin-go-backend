import {
  MarketComparableStatus,
  MarketPricingRunStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import type {
  DerivedMarketPricingSnapshot,
  MarketPricingRefreshStore,
} from "./market-pricing-refresh.service";
import type { MarketComparableCandidate } from "./market-pricing-provider.contract";

const MARKET_PRICING_LOCK_PREFIX = "MARKET_PRICING_REFRESH:";
const MARKET_PRICING_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

function isoDate(value: string, code: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(code);
  }
  return parsed;
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function comparableAttributes(
  comparable: MarketComparableCandidate,
): Prisma.InputJsonValue {
  return {
    providerAttributes:
      comparable.attributes === null
        ? null
        : (comparable.attributes as Prisma.InputJsonValue),
    propertyType: comparable.propertyType,
    bedrooms: comparable.bedrooms,
    bathrooms: comparable.bathrooms,
    maxGuests: comparable.maxGuests,
    amenityCodes: comparable.amenityCodes,
    reviewScore: comparable.reviewScore,
    reviewCount: comparable.reviewCount,
  };
}

function snapshotEvidence(
  snapshot: DerivedMarketPricingSnapshot,
): Prisma.InputJsonValue {
  return {
    ...snapshot.evidence,
    currency: snapshot.currency,
  };
}

function targetChanged(
  previous:
    | {
        targetRate: Prisma.Decimal;
        confidence: Prisma.Decimal;
      }
    | undefined,
  current: DerivedMarketPricingSnapshot,
  minimumConfidence: number,
) {
  if (!previous) return true;

  const previousTarget = Number(previous.targetRate);
  const previousConfidence = Number(previous.confidence);
  const priceChanged = Math.abs(previousTarget - current.targetRate) >= 0.005;
  const eligibilityChanged =
    previousConfidence >= minimumConfidence !==
    current.confidence >= minimumConfidence;

  return priceChanged || eligibilityChanged;
}

async function acquireProfileLock(
  tx: Prisma.TransactionClient,
  profileId: string,
): Promise<void> {
  const key = `${MARKET_PRICING_LOCK_PREFIX}${profileId}`;
  await tx.$executeRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${key}, 0)
      )
    `,
  );
}

async function upsertComparables(
  tx: Prisma.TransactionClient,
  input: {
    profileId: string;
    provider: string;
    comparables: MarketComparableCandidate[];
    observedAt: Date;
  },
): Promise<void> {
  const activeExternalIds = input.comparables.map(
    (comparable) => comparable.externalListingId,
  );

  await tx.marketComparable.updateMany({
    where: {
      profileId: input.profileId,
      provider: input.provider,
      status: MarketComparableStatus.ACTIVE,
      ...(activeExternalIds.length > 0
        ? { externalListingId: { notIn: activeExternalIds } }
        : {}),
    },
    data: { status: MarketComparableStatus.STALE },
  });

  for (const comparable of input.comparables) {
    await tx.marketComparable.upsert({
      where: {
        profileId_provider_externalListingId: {
          profileId: input.profileId,
          provider: input.provider,
          externalListingId: comparable.externalListingId,
        },
      },
      create: {
        profileId: input.profileId,
        provider: input.provider,
        externalListingId: comparable.externalListingId,
        listingName: comparable.listingName,
        latitude: comparable.latitude,
        longitude: comparable.longitude,
        distanceKm: comparable.distanceKm,
        similarityScore: comparable.similarityScore,
        status: MarketComparableStatus.ACTIVE,
        attributes: comparableAttributes(comparable),
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
      },
      update: {
        listingName: comparable.listingName,
        latitude: comparable.latitude,
        longitude: comparable.longitude,
        distanceKm: comparable.distanceKm,
        similarityScore: comparable.similarityScore,
        status: MarketComparableStatus.ACTIVE,
        attributes: comparableAttributes(comparable),
        lastSeenAt: input.observedAt,
      },
    });
  }
}

export function createPrismaMarketPricingRefreshStore(
  prisma: PrismaClient,
): MarketPricingRefreshStore {
  return {
    async createRun(input) {
      if (
        !(input.startedAt instanceof Date) ||
        Number.isNaN(input.startedAt.getTime())
      ) {
        throw new Error("MARKET_PRICING_STARTED_AT_INVALID");
      }
      const requestedDateFrom = isoDate(
        input.requestedDateFrom,
        "MARKET_PRICING_REQUESTED_DATE_FROM_INVALID",
      );
      const requestedDateTo = isoDate(
        input.requestedDateToExclusive,
        "MARKET_PRICING_REQUESTED_DATE_TO_INVALID",
      );
      const staleBefore = new Date(
        input.startedAt.getTime() - MARKET_PRICING_RUN_STALE_AFTER_MS,
      );

      return prisma.$transaction(async (tx) => {
        await acquireProfileLock(tx, input.profileId);

        await tx.marketPricingRun.updateMany({
          where: {
            profileId: input.profileId,
            status: {
              in: [
                MarketPricingRunStatus.PENDING,
                MarketPricingRunStatus.RUNNING,
              ],
            },
            OR: [
              { startedAt: { lte: staleBefore } },
              {
                startedAt: null,
                createdAt: { lte: staleBefore },
              },
            ],
          },
          data: {
            status: MarketPricingRunStatus.FAILED,
            completedAt: input.startedAt,
            errorCode: "STALE_RUN_RECOVERED",
            errorSummary:
              "An abandoned market pricing refresh was closed before a new attempt.",
          },
        });

        const activeRun = await tx.marketPricingRun.findFirst({
          where: {
            profileId: input.profileId,
            status: {
              in: [
                MarketPricingRunStatus.PENDING,
                MarketPricingRunStatus.RUNNING,
              ],
            },
          },
          select: { id: true },
        });
        if (activeRun) {
          throw new Error("MARKET_PRICING_REFRESH_ALREADY_RUNNING");
        }

        const run = await tx.marketPricingRun.create({
          data: {
            profileId: input.profileId,
            provider: input.provider,
            status: MarketPricingRunStatus.RUNNING,
            requestedDateFrom,
            requestedDateTo,
            startedAt: input.startedAt,
            metadata: {
              rangeSemantics: "DATE_TO_EXCLUSIVE",
            },
          },
          select: { id: true },
        });

        return { runId: run.id };
      });
    },

    async completeRunAtomically(input) {
      return prisma.$transaction(async (tx) => {
        await acquireProfileLock(tx, input.profileId);

        const run = await tx.marketPricingRun.findUnique({
          where: { id: input.runId },
          select: {
            id: true,
            profileId: true,
            provider: true,
            status: true,
          },
        });
        if (
          !run ||
          run.profileId !== input.profileId ||
          run.provider !== input.provider ||
          run.status !== MarketPricingRunStatus.RUNNING
        ) {
          throw new Error("MARKET_PRICING_RUN_NOT_COMPLETABLE");
        }
        if (input.snapshots.length === 0) {
          throw new Error("MARKET_PRICING_SNAPSHOTS_REQUIRED");
        }

        const profile = await tx.marketPricingProfile.findUnique({
          where: { id: input.profileId },
          select: {
            minimumConfidence: true,
            refreshIntervalHours: true,
          },
        });
        if (!profile) {
          throw new Error("MARKET_PRICING_PROFILE_NOT_FOUND");
        }

        const stayDates = input.snapshots.map((snapshot) =>
          isoDate(snapshot.stayDate, "MARKET_PRICING_STAY_DATE_INVALID"),
        );
        const previousRows = await tx.marketPricingSnapshot.findMany({
          where: {
            profileId: input.profileId,
            provider: input.provider,
            stayDate: { in: stayDates },
          },
          orderBy: [
            { stayDate: "asc" },
            { observedAt: "desc" },
            { createdAt: "desc" },
          ],
          select: {
            stayDate: true,
            targetRate: true,
            confidence: true,
          },
        });
        const previousByDate = new Map<
          string,
          { targetRate: Prisma.Decimal; confidence: Prisma.Decimal }
        >();
        for (const row of previousRows) {
          const key = dateKey(row.stayDate);
          if (!previousByDate.has(key)) previousByDate.set(key, row);
        }

        await upsertComparables(tx, {
          profileId: input.profileId,
          provider: input.provider,
          comparables: input.comparables,
          observedAt: input.snapshots[0].observedAt,
        });

        const created = await tx.marketPricingSnapshot.createMany({
          data: input.snapshots.map((snapshot) => ({
            profileId: input.profileId,
            runId: input.runId,
            provider: input.provider,
            stayDate: isoDate(
              snapshot.stayDate,
              "MARKET_PRICING_STAY_DATE_INVALID",
            ),
            sampleSize: snapshot.sampleSize,
            availableCount: snapshot.availableCount,
            lowerRate: snapshot.lowerRate,
            medianRate: snapshot.medianRate,
            upperRate: snapshot.upperRate,
            targetRate: snapshot.targetRate,
            confidence: snapshot.confidence,
            observedAt: snapshot.observedAt,
            expiresAt: snapshot.expiresAt,
            evidence: snapshotEvidence(snapshot),
          })),
          skipDuplicates: true,
        });

        const minimumConfidence = Number(profile.minimumConfidence);
        const changedDateKeys = input.snapshots
          .filter((snapshot) =>
            targetChanged(
              previousByDate.get(snapshot.stayDate),
              snapshot,
              minimumConfidence,
            ),
          )
          .map((snapshot) => snapshot.stayDate)
          .sort();

        const completed = await tx.marketPricingRun.updateMany({
          where: {
            id: input.runId,
            status: MarketPricingRunStatus.RUNNING,
          },
          data: {
            status: MarketPricingRunStatus.SUCCEEDED,
            comparableCount: input.comparables.length,
            snapshotCount: created.count,
            changedDateKeys,
            completedAt: input.completedAt,
            errorCode: null,
            errorSummary: null,
            metadata: {
              providerRequestId: input.providerRequestId,
              rangeSemantics: "DATE_TO_EXCLUSIVE",
            },
          },
        });
        if (completed.count !== 1) {
          throw new Error("MARKET_PRICING_RUN_COMPLETION_LOST");
        }

        const nextRefreshAt = new Date(
          input.completedAt.getTime() +
            profile.refreshIntervalHours * 60 * 60 * 1000,
        );
        await tx.marketPricingProfile.update({
          where: { id: input.profileId },
          data: {
            lastSuccessfulRefreshAt: input.completedAt,
            nextRefreshAt,
            lastErrorCode: null,
          },
        });

        return {
          snapshotCount: created.count,
          changedDateKeys,
        };
      });
    },

    async failRun(input) {
      const run = await prisma.marketPricingRun.findUnique({
        where: { id: input.runId },
        select: { profileId: true },
      });
      if (!run) return;

      await prisma.$transaction(async (tx) => {
        await acquireProfileLock(tx, run.profileId);
        const failed = await tx.marketPricingRun.updateMany({
          where: {
            id: input.runId,
            status: {
              in: [
                MarketPricingRunStatus.PENDING,
                MarketPricingRunStatus.RUNNING,
              ],
            },
          },
          data: {
            status: MarketPricingRunStatus.FAILED,
            completedAt: input.completedAt,
            errorCode: input.errorCode,
            errorSummary: input.errorSummary,
          },
        });
