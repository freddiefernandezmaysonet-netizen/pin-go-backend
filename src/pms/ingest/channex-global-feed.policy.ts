import type { ChannexBookingRevision } from "../adapters/types";

export type ChannexGlobalFeedSource = {
  sourceId: string;
  fetchRevisions: () => Promise<ChannexBookingRevision[]>;
};

export type ChannexGlobalFeedTarget = {
  organizationId: string;
  propertyId: string;
  connectionId: string;
};

export type ChannexGlobalFeedTargetResolution =
  | {
      kind: "RESOLVED";
      target: ChannexGlobalFeedTarget;
    }
  | {
      kind: "UNMAPPED";
    }
  | {
      kind: "AMBIGUOUS";
      candidateConnectionIds?: string[];
    };

export type ChannexGlobalFeedRevisionResult = {
  sourceId: string;
  revisionId: string;
  propertyId: string;
  insertedAt: string | null;
  outcome:
    | "ACKNOWLEDGED"
    | "DUPLICATE_SKIPPED"
    | "INVALID_INSERTED_AT"
    | "PROPERTY_UNMAPPED"
    | "PROPERTY_AMBIGUOUS"
    | "TARGET_RESOLUTION_FAILED"
    | "PERSISTENCE_FAILED"
    | "ACKNOWLEDGEMENT_FAILED";
  target?: ChannexGlobalFeedTarget;
  error?: string;
};

export type ChannexGlobalFeedRunResult = {
  status: "COMPLETED" | "SKIPPED_CONCURRENT_RUN";
  sourceCount: number;
  fetchedSourceCount: number;
  failedSourceCount: number;
  fetchedRevisionCount: number;
  acknowledgedRevisionCount: number;
  failedRevisionCount: number;
  duplicateRevisionCount: number;
  emptyFeed: boolean;
  sourceErrors: Array<{
    sourceId: string;
    error: string;
  }>;
  revisions: ChannexGlobalFeedRevisionResult[];
};

function normalizeString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function getRevisionTimestamp(revision: ChannexBookingRevision) {
  const insertedAt = normalizeString(revision.identity.insertedAt);
  if (!insertedAt) return null;

  const timestamp = Date.parse(insertedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function processChannexGlobalBookingRevisionFeed(args: {
  sources: ChannexGlobalFeedSource[];
  acquireRunLease: () => Promise<boolean>;
  releaseRunLease: () => Promise<void>;
  resolveTarget: (input: {
    sourceId: string;
    revision: ChannexBookingRevision;
  }) => Promise<ChannexGlobalFeedTargetResolution>;
  persistRevision: (input: {
    sourceId: string;
    revision: ChannexBookingRevision;
    target: ChannexGlobalFeedTarget;
  }) => Promise<void>;
  acknowledgeRevision: (input: {
    sourceId: string;
    revision: ChannexBookingRevision;
    target: ChannexGlobalFeedTarget;
  }) => Promise<void>;
}): Promise<ChannexGlobalFeedRunResult> {
  const leaseAcquired = await args.acquireRunLease();

  if (!leaseAcquired) {
    return {
      status: "SKIPPED_CONCURRENT_RUN",
      sourceCount: args.sources.length,
      fetchedSourceCount: 0,
      failedSourceCount: 0,
      fetchedRevisionCount: 0,
      acknowledgedRevisionCount: 0,
      failedRevisionCount: 0,
      duplicateRevisionCount: 0,
      emptyFeed: true,
      sourceErrors: [],
      revisions: [],
    };
  }

  const sourceErrors: ChannexGlobalFeedRunResult["sourceErrors"] = [];
  const revisionResults: ChannexGlobalFeedRevisionResult[] = [];
  const fetched: Array<{
    sourceId: string;
    revision: ChannexBookingRevision;
  }> = [];
  let fetchedSourceCount = 0;

  try {
    for (const source of args.sources) {
      try {
        const revisions = await source.fetchRevisions();
        fetchedSourceCount += 1;

        for (const revision of revisions) {
          fetched.push({ sourceId: source.sourceId, revision });
        }
      } catch (error) {
        sourceErrors.push({
          sourceId: source.sourceId,
          error: errorMessage(error),
        });
      }
    }

    fetched.sort((left, right) => {
      const leftTimestamp = getRevisionTimestamp(left.revision);
      const rightTimestamp = getRevisionTimestamp(right.revision);

      if (leftTimestamp !== null && rightTimestamp !== null) {
        if (leftTimestamp !== rightTimestamp) {
          return leftTimestamp - rightTimestamp;
        }
      } else if (leftTimestamp !== null) {
        return -1;
      } else if (rightTimestamp !== null) {
        return 1;
      }

      const revisionOrder = left.revision.identity.revisionId.localeCompare(
        right.revision.identity.revisionId
      );

      return revisionOrder !== 0
        ? revisionOrder
        : left.sourceId.localeCompare(right.sourceId);
    });

    const completedRevisionIds = new Set<string>();

    for (const item of fetched) {
      const revisionId = normalizeString(item.revision.identity.revisionId) ?? "";
      const propertyId = normalizeString(item.revision.identity.propertyId) ?? "";
      const insertedAt = normalizeString(item.revision.identity.insertedAt);

      if (completedRevisionIds.has(revisionId)) {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "DUPLICATE_SKIPPED",
        });
        continue;
      }

      if (getRevisionTimestamp(item.revision) === null) {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "INVALID_INSERTED_AT",
        });
        continue;
      }

      let resolution: ChannexGlobalFeedTargetResolution;

      try {
        resolution = await args.resolveTarget({
          sourceId: item.sourceId,
          revision: item.revision,
        });
      } catch (error) {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "TARGET_RESOLUTION_FAILED",
          error: errorMessage(error),
        });
        continue;
      }

      if (resolution.kind === "UNMAPPED") {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "PROPERTY_UNMAPPED",
        });
        continue;
      }

      if (resolution.kind === "AMBIGUOUS") {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "PROPERTY_AMBIGUOUS",
          error: resolution.candidateConnectionIds?.join(",") || undefined,
        });
        continue;
      }

      try {
        await args.persistRevision({
          sourceId: item.sourceId,
          revision: item.revision,
          target: resolution.target,
        });
      } catch (error) {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "PERSISTENCE_FAILED",
          target: resolution.target,
          error: errorMessage(error),
        });
        continue;
      }

      try {
        await args.acknowledgeRevision({
          sourceId: item.sourceId,
          revision: item.revision,
          target: resolution.target,
        });
      } catch (error) {
        revisionResults.push({
          sourceId: item.sourceId,
          revisionId,
          propertyId,
          insertedAt,
          outcome: "ACKNOWLEDGEMENT_FAILED",
          target: resolution.target,
          error: errorMessage(error),
        });
        continue;
      }

      completedRevisionIds.add(revisionId);
      revisionResults.push({
        sourceId: item.sourceId,
        revisionId,
        propertyId,
        insertedAt,
        outcome: "ACKNOWLEDGED",
        target: resolution.target,
      });
    }

    const acknowledgedRevisionCount = revisionResults.filter(
      (result) => result.outcome === "ACKNOWLEDGED"
    ).length;
    const duplicateRevisionCount = revisionResults.filter(
      (result) => result.outcome === "DUPLICATE_SKIPPED"
    ).length;
    const failedRevisionCount = revisionResults.length -
      acknowledgedRevisionCount -
      duplicateRevisionCount;

    return {
      status: "COMPLETED",
      sourceCount: args.sources.length,
      fetchedSourceCount,
      failedSourceCount: sourceErrors.length,
      fetchedRevisionCount: fetched.length,
      acknowledgedRevisionCount,
      failedRevisionCount,
      duplicateRevisionCount,
      emptyFeed: fetched.length === 0,
      sourceErrors,
      revisions: revisionResults,
    };
  } finally {
    await args.releaseRunLease();
  }
}
