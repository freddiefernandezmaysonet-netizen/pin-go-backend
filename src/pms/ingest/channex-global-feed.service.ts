import crypto from "crypto";
import {
  PrismaClient,
  PmsConnectionStatus,
  PmsProvider,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  resolveChannexGlobalFeedConfig,
  type ChannexGlobalFeedConfig,
} from "../../workers/channex-global-feed.config";
import { getAdapter } from "../adapters";
import type {
  ChannexBookingRevision,
  PmsAdapterConnection,
} from "../adapters/types";
import {
  acknowledgePersistedChannexBookingRevision,
  persistChannexBookingRevision,
} from "./channex-booking-lifecycle.service";
import {
  processChannexGlobalBookingRevisionFeed,
  type ChannexGlobalFeedRunResult,
  type ChannexGlobalFeedSource,
  type ChannexGlobalFeedTarget,
} from "./channex-global-feed.policy";

const CHANNEX_GLOBAL_FEED_LEASE_KEY =
  "pin-go:channex-global-booking-revision-feed:v1";

export type ActiveChannexConnection = {
  id: string;
  organizationId: string;
  credentialsEncrypted: string | null;
  metadata: unknown;
  listings: Array<{
    propertyId: string | null;
    metadata: unknown;
  }>;
};

type CredentialSource = {
  sourceId: string;
  connection: PmsAdapterConnection;
  connections: ActiveChannexConnection[];
};

type PreloadedSource = {
  sourceId: string;
  revisions: ChannexBookingRevision[];
  error: string | null;
};

type PersistedRevision = Awaited<
  ReturnType<typeof persistChannexBookingRevision>
>;

export type ChannexGlobalFeedExecutionResult = ChannexGlobalFeedRunResult & {
  connectionCount: number;
  credentialSourceCount: number;
  discoveredRevisionCount: number;
  selectedRevisionCount: number;
  truncatedRevisionCount: number;
};

export type ChannexGlobalFeedExecutionDependencies = {
  acquireRunLease: (args: { leaseMs: number }) => Promise<boolean>;
  releaseRunLease: () => Promise<void>;
  loadActiveConnections: () => Promise<ActiveChannexConnection[]>;
  fetchBookingRevisionFeed: (args: {
    sourceId: string;
    connection: PmsAdapterConnection;
  }) => Promise<ChannexBookingRevision[]>;
  persistBookingRevision: (args: {
    correlationId: string;
    organizationId: string;
    connectionId: string;
    revision: ChannexBookingRevision;
  }) => Promise<PersistedRevision>;
  acknowledgeBookingRevision: (args: {
    sourceId: string;
    connection: PmsAdapterConnection;
    persisted: PersistedRevision;
  }) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildCredentialSourceId(connection: ActiveChannexConnection) {
  const credentialMaterial = connection.credentialsEncrypted
    ? `encrypted:${connection.credentialsEncrypted}`
    : "environment:CHANNEX_API_KEY";

  const fingerprint = crypto
    .createHash("sha256")
    .update(credentialMaterial)
    .digest("hex")
    .slice(0, 24);

  return `channex-source:${fingerprint}`;
}

function buildCredentialSources(
  connections: ActiveChannexConnection[]
): CredentialSource[] {
  const grouped = new Map<string, ActiveChannexConnection[]>();

  for (const connection of connections) {
    const sourceId = buildCredentialSourceId(connection);
    const existing = grouped.get(sourceId) ?? [];
    existing.push(connection);
    grouped.set(sourceId, existing);
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, sourceConnections]) => {
      const representative = sourceConnections[0];

      if (!representative) {
        throw new Error(`CHANNEX_GLOBAL_FEED_SOURCE_EMPTY:${sourceId}`);
      }

      return {
        sourceId,
        connection: {
          id: representative.id,
          credentialsEncrypted: representative.credentialsEncrypted,
          metadata: representative.metadata,
        },
        connections: sourceConnections,
      };
    });
}

function revisionTimestamp(revision: ChannexBookingRevision) {
  const insertedAt = asString(revision.identity.insertedAt);
  if (!insertedAt) return Number.POSITIVE_INFINITY;

  const timestamp = Date.parse(insertedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function selectOldestRevisions(args: {
  preloaded: PreloadedSource[];
  maxRevisionsPerRun: number;
}) {
  const allRevisions = args.preloaded.flatMap((source) =>
    source.revisions.map((revision) => ({
      sourceId: source.sourceId,
      revision,
    }))
  );

  allRevisions.sort((left, right) => {
    const timestampDelta =
      revisionTimestamp(left.revision) - revisionTimestamp(right.revision);

    if (timestampDelta !== 0) return timestampDelta;

    const revisionDelta = left.revision.identity.revisionId.localeCompare(
      right.revision.identity.revisionId
    );

    return revisionDelta !== 0
      ? revisionDelta
      : left.sourceId.localeCompare(right.sourceId);
  });

  return {
    discoveredRevisionCount: allRevisions.length,
    selected: allRevisions.slice(0, args.maxRevisionsPerRun),
  };
}

function buildTargetCandidates(sources: CredentialSource[]) {
  const candidates = new Map<string, Map<string, ChannexGlobalFeedTarget>>();

  for (const source of sources) {
    for (const connection of source.connections) {
      for (const listing of connection.listings) {
        const propertyId = asString(listing.propertyId);
        const channexPropertyId = asString(
          asRecord(listing.metadata).channexPropertyId
        );

        if (!propertyId || !channexPropertyId) continue;

        const lookupKey = `${source.sourceId}:${channexPropertyId}`;
        const targetKey = `${connection.id}:${propertyId}`;
        const byTarget = candidates.get(lookupKey) ?? new Map();

        byTarget.set(targetKey, {
          organizationId: connection.organizationId,
          propertyId,
          connectionId: connection.id,
        });

        candidates.set(lookupKey, byTarget);
      }
    }
  }

  return candidates;
}

function skippedConcurrentRun(): ChannexGlobalFeedExecutionResult {
  return {
    status: "SKIPPED_CONCURRENT_RUN",
    sourceCount: 0,
    fetchedSourceCount: 0,
    failedSourceCount: 0,
    fetchedRevisionCount: 0,
    acknowledgedRevisionCount: 0,
    failedRevisionCount: 0,
    duplicateRevisionCount: 0,
    emptyFeed: true,
    sourceErrors: [],
    revisions: [],
    connectionCount: 0,
    credentialSourceCount: 0,
    discoveredRevisionCount: 0,
    selectedRevisionCount: 0,
    truncatedRevisionCount: 0,
  };
}

export async function executeChannexGlobalFeedOnce(args: {
  config: ChannexGlobalFeedConfig;
  dependencies: ChannexGlobalFeedExecutionDependencies;
}): Promise<ChannexGlobalFeedExecutionResult> {
  const leaseAcquired = await args.dependencies.acquireRunLease({
    leaseMs: args.config.leaseMs,
  });

  if (!leaseAcquired) {
    return skippedConcurrentRun();
  }

  try {
    const connections = await args.dependencies.loadActiveConnections();
    const credentialSources = buildCredentialSources(connections);

    if (credentialSources.length > args.config.maxSourcesPerRun) {
      throw new Error(
        `CHANNEX_GLOBAL_FEED_SOURCE_LIMIT_EXCEEDED:${credentialSources.length}:${args.config.maxSourcesPerRun}`
      );
    }

    const preloaded = await Promise.all(
      credentialSources.map(async (source): Promise<PreloadedSource> => {
        try {
          return {
            sourceId: source.sourceId,
            revisions: await args.dependencies.fetchBookingRevisionFeed({
              sourceId: source.sourceId,
              connection: source.connection,
            }),
            error: null,
          };
        } catch (error) {
          return {
            sourceId: source.sourceId,
            revisions: [],
            error: errorMessage(error),
          };
        }
      })
    );

    const selection = selectOldestRevisions({
      preloaded,
      maxRevisionsPerRun: args.config.maxRevisionsPerRun,
    });
    const selectedBySource = new Map<string, ChannexBookingRevision[]>();

    for (const item of selection.selected) {
      const revisions = selectedBySource.get(item.sourceId) ?? [];
      revisions.push(item.revision);
      selectedBySource.set(item.sourceId, revisions);
    }

    const preloadBySource = new Map(
      preloaded.map((source) => [source.sourceId, source] as const)
    );
    const sourceById = new Map(
      credentialSources.map((source) => [source.sourceId, source] as const)
    );
    const policySources: ChannexGlobalFeedSource[] = credentialSources.map(
      (source) => ({
        sourceId: source.sourceId,
        fetchRevisions: async () => {
          const preload = preloadBySource.get(source.sourceId);

          if (!preload) {
            throw new Error(
              `CHANNEX_GLOBAL_FEED_SOURCE_PRELOAD_MISSING:${source.sourceId}`
            );
          }

          if (preload.error) {
            throw new Error(preload.error);
          }

          return selectedBySource.get(source.sourceId) ?? [];
        },
      })
    );
    const targetCandidates = buildTargetCandidates(credentialSources);
    const persistedByRevision = new Map<string, PersistedRevision>();

    const result = await processChannexGlobalBookingRevisionFeed({
      sources: policySources,
      acquireRunLease: async () => true,
      releaseRunLease: async () => undefined,
      resolveTarget: async ({ sourceId, revision }) => {
        const lookupKey = `${sourceId}:${revision.identity.propertyId}`;
        const candidates = Array.from(
          targetCandidates.get(lookupKey)?.values() ?? []
        );

        if (candidates.length === 0) {
          return { kind: "UNMAPPED" };
        }

        if (candidates.length > 1) {
          return {
            kind: "AMBIGUOUS",
            candidateConnectionIds: candidates.map(
              (candidate) => candidate.connectionId
            ),
          };
        }

        return {
          kind: "RESOLVED",
          target: candidates[0]!,
        };
      },
      persistRevision: async ({ sourceId, revision, target }) => {
        const correlationId =
          `channex-global-feed:${sourceId}:${revision.identity.revisionId}`;
        const persisted = await args.dependencies.persistBookingRevision({
          correlationId,
          organizationId: target.organizationId,
          connectionId: target.connectionId,
          revision,
        });

        if (
          persisted.organizationId !== target.organizationId ||
          persisted.propertyId !== target.propertyId
        ) {
          throw new Error(
            `CHANNEX_GLOBAL_FEED_TARGET_CHANGED:${revision.identity.revisionId}`
          );
        }

        persistedByRevision.set(
          `${sourceId}:${revision.identity.revisionId}`,
          persisted
        );
      },
      acknowledgeRevision: async ({ sourceId, revision }) => {
        const persisted = persistedByRevision.get(
          `${sourceId}:${revision.identity.revisionId}`
        );
        const source = sourceById.get(sourceId);

        if (!persisted) {
          throw new Error(
            `CHANNEX_GLOBAL_FEED_PERSISTENCE_RESULT_MISSING:${revision.identity.revisionId}`
          );
        }

        if (!source) {
          throw new Error(`CHANNEX_GLOBAL_FEED_SOURCE_MISSING:${sourceId}`);
        }

        await args.dependencies.acknowledgeBookingRevision({
          sourceId,
          connection: source.connection,
          persisted,
        });
      },
    });

    return {
      ...result,
      connectionCount: connections.length,
      credentialSourceCount: credentialSources.length,
      discoveredRevisionCount: selection.discoveredRevisionCount,
      selectedRevisionCount: selection.selected.length,
      truncatedRevisionCount:
        selection.discoveredRevisionCount - selection.selected.length,
    };
  } finally {
    await args.dependencies.releaseRunLease();
  }
}

function buildSingleConnectionDatabaseUrl() {
  const rawDatabaseUrl = asString(process.env.DATABASE_URL);

  if (!rawDatabaseUrl) {
    throw new Error("DATABASE_URL_NOT_CONFIGURED");
  }

  const databaseUrl = new URL(rawDatabaseUrl);
  databaseUrl.searchParams.set("connection_limit", "1");
  databaseUrl.searchParams.set("pool_timeout", "5");

  return databaseUrl.toString();
}

function createPostgresAdvisoryLease() {
  const leaseClient = new PrismaClient({
    datasources: {
      db: {
        url: buildSingleConnectionDatabaseUrl(),
      },
    },
  });
  let acquired = false;
  let warningTimer: NodeJS.Timeout | null = null;

  return {
    acquire: async ({ leaseMs }: { leaseMs: number }) => {
      try {
        await leaseClient.$connect();
        const rows = await leaseClient.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_lock(
            hashtext(${CHANNEX_GLOBAL_FEED_LEASE_KEY})
          ) AS "acquired"
        `;

        acquired = rows[0]?.acquired === true;

        if (!acquired) {
          await leaseClient.$disconnect();
          return false;
        }

        warningTimer = setTimeout(() => {
          console.error("[CHANNEX_GLOBAL_FEED_LEASE_EXCEEDED]", {
            leaseKey: CHANNEX_GLOBAL_FEED_LEASE_KEY,
            leaseMs,
          });
        }, leaseMs);
        warningTimer.unref();

        return true;
      } catch (error) {
        await leaseClient.$disconnect().catch(() => undefined);
        throw error;
      }
    },
    release: async () => {
      if (warningTimer) {
        clearTimeout(warningTimer);
        warningTimer = null;
      }

      try {
        if (acquired) {
          const rows = await leaseClient.$queryRaw<Array<{ released: boolean }>>`
            SELECT pg_advisory_unlock(
              hashtext(${CHANNEX_GLOBAL_FEED_LEASE_KEY})
            ) AS "released"
          `;

          if (rows[0]?.released !== true) {
            console.error("[CHANNEX_GLOBAL_FEED_LEASE_RELEASE_NOT_CONFIRMED]", {
              leaseKey: CHANNEX_GLOBAL_FEED_LEASE_KEY,
            });
          }
        }
      } finally {
        acquired = false;
        await leaseClient.$disconnect().catch(() => undefined);
      }
    },
  };
}

export async function runChannexGlobalFeedOnce(args?: {
  config?: ChannexGlobalFeedConfig;
}): Promise<ChannexGlobalFeedExecutionResult> {
  const config = args?.config ?? resolveChannexGlobalFeedConfig();
  const adapter = getAdapter(PmsProvider.CHANNEX);

  if (
    !adapter.fetchBookingRevisionFeed ||
    !adapter.acknowledgeBookingRevision
  ) {
    throw new Error("CHANNEX_GLOBAL_FEED_ADAPTER_INCOMPLETE");
  }

  const lease = createPostgresAdvisoryLease();

  return executeChannexGlobalFeedOnce({
    config,
    dependencies: {
      acquireRunLease: lease.acquire,
      releaseRunLease: lease.release,
      loadActiveConnections: async () =>
        prisma.pmsConnection.findMany({
          where: {
            provider: PmsProvider.CHANNEX,
            status: PmsConnectionStatus.ACTIVE,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            organizationId: true,
            credentialsEncrypted: true,
            metadata: true,
            listings: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                propertyId: true,
                metadata: true,
              },
            },
          },
        }),
      fetchBookingRevisionFeed: async ({ connection }) =>
        adapter.fetchBookingRevisionFeed!({ connection }),
      persistBookingRevision: persistChannexBookingRevision,
      acknowledgeBookingRevision: async ({ connection, persisted }) => {
        await acknowledgePersistedChannexBookingRevision({
          ...persisted,
          acknowledge: async (revisionId) => {
            await adapter.acknowledgeBookingRevision!({
              connection,
              revisionId,
            });
          },
        });
      },
    },
  });
}
