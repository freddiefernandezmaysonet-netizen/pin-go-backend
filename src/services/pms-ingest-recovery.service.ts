import type { PrismaClient } from "@prisma/client";

import {
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";
import {
  processWebhookEventById,
} from "../pms/ingest/webhook.processor";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_PROCESSING_MS =
  10 * 60 * 1000;
const DEFAULT_PENDING_RECHECK_MS =
  60 * 1000;

const RETRY_BACKOFF_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
] as const;

export type PmsIngestRecoveryState =
  | "WAITING"
  | "RUNNING"
  | "EXHAUSTED";

export type PmsIngestRecoveryEventContext = {
  eventId: string;
  connectionId: string;
  organizationId: string;
  provider: string;
  eventType: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  state: PmsIngestRecoveryState;
  occurredAt: Date;
};

export type PmsIngestRecoveryOptions = {
  maxAttempts?: number;
  batchSize?: number;
  staleProcessingMs?: number;
  processEvent?: (
    eventId: string
  ) => Promise<void>;
  recordState?: (
    input: PmsIngestRecoveryEventContext
  ) => Promise<void>;
  resolveState?: (
    input: Omit<
      PmsIngestRecoveryEventContext,
      "state" | "nextAttemptAt"
    >
  ) => Promise<void>;
};

export type PmsIngestRecoveryResult = {
  staleReleased: number;
  scanned: number;
  attempted: number;
  recovered: number;
  scheduled: number;
  running: number;
  exhausted: number;
  failed: number;
};

type RecoveryCandidate = {
  id: string;
  connectionId: string;
  provider: unknown;
  eventType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  updatedAt: Date;
  connection: {
    organizationId: string;
    status: string;
  };
};

function normalizePositiveInteger(
  value: unknown,
  fallback: number
) {
  const parsed = Number(value);

  return Number.isInteger(parsed) &&
    parsed > 0
    ? parsed
    : fallback;
}

function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number
) {
  const parsed = Number(value);

  return Number.isInteger(parsed) &&
    parsed >= 0
    ? parsed
    : fallback;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildOperationalKey(eventId: string) {
  return `PMS_INGEST_RECOVERY:${eventId}`;
}

export function getPmsIngestRecoveryBackoffMs(
  attemptCount: number
) {
  if (attemptCount <= 0) {
    return 0;
  }

  const index = Math.min(
    attemptCount - 1,
    RETRY_BACKOFF_MS.length - 1
  );

  return RETRY_BACKOFF_MS[index];
}

export function getPmsIngestRecoveryNextAttemptAt(
  lastUpdatedAt: Date,
  attemptCount: number
) {
  return new Date(
    lastUpdatedAt.getTime() +
      getPmsIngestRecoveryBackoffMs(
        attemptCount
      )
  );
}

function toContext(input: {
  event: RecoveryCandidate;
  maxAttempts: number;
  state: PmsIngestRecoveryState;
  nextAttemptAt: Date | null;
  occurredAt: Date;
}): PmsIngestRecoveryEventContext {
  return {
    eventId: input.event.id,
    connectionId:
      input.event.connectionId,
    organizationId:
      input.event.connection.organizationId,
    provider: String(
      input.event.provider
    ),
    eventType: input.event.eventType,
    attemptCount:
      input.event.attempts,
    maxAttempts: input.maxAttempts,
    lastError:
      input.event.lastError,
    nextAttemptAt:
      input.nextAttemptAt,
    state: input.state,
    occurredAt: input.occurredAt,
  };
}

async function persistRecoveryState(
  prisma: PrismaClient,
  input: PmsIngestRecoveryEventContext
) {
  const operationalKey =
    buildOperationalKey(input.eventId);

  const providerLabel =
    input.provider || "PMS";

  if (input.state === "EXHAUSTED") {
    await upsertOperationalIssue(
      prisma,
      {
        operationalKey,
        issueCode:
          "PMS_INGEST_RECOVERY_EXHAUSTED",
        title:
          "PMS event requires host attention",
        issue:
          `Pin&Go exhausted ${input.maxAttempts} automatic attempts to process a ${providerLabel} event.`,
        operationalImpact:
          "The associated reservation, availability or payment change may not be reflected in Pin&Go until the integration issue is corrected.",
        recommendedAction:
          "Review the PMS connection and listing mapping, then retry the failed integration event or contact Pin&Go support.",
        nextAutomaticStep: null,

        engine: "DISTRIBUTION_PMS",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        visibility: "HOST",
        responsibleActor: "HOST",

        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
        autoResolveActionCode: null,

        organizationId:
          input.organizationId,
        propertyId: null,
        reservationId: null,

        decisionId:
          `pms-ingest-recovery:${input.eventId}`,
        sourceType: "WORKER",
        actionTarget: "DISTRIBUTION",

        metadata: {
          eventId: input.eventId,
          connectionId:
            input.connectionId,
          provider: input.provider,
          eventType: input.eventType,
          attempt:
            input.attemptCount,
          maxAttempts:
            input.maxAttempts,
          nextAttemptAt: null,
          exhausted: true,
          lastError:
            input.lastError,
        },

        transitionCode:
          "PMS_INGEST_RECOVERY_EXHAUSTED",
        transitionSummary:
          "Distribution / PMS exhausted its automatic ingest recovery budget and transferred responsibility to the host.",
        transitionedBy: "PIN_GO",
        occurredAt:
          input.occurredAt,
        lastSignalAt:
          input.occurredAt,
      }
    );

    return;
  }

  const running =
    input.state === "RUNNING";

  await upsertOperationalIssue(
    prisma,
    {
      operationalKey,
      issueCode: running
        ? "PMS_INGEST_RECOVERY_RUNNING"
        : "PMS_INGEST_RETRY_SCHEDULED",
      title: running
        ? "Pin&Go is recovering a PMS event"
        : "Pin&Go scheduled a PMS ingest retry",
      issue:
        `Pin&Go could not complete a ${providerLabel} event and retained ownership of the integration recovery workflow.`,
      operationalImpact:
        "The associated reservation, availability or payment change may be delayed until the automatic recovery succeeds.",
      recommendedAction: null,
      nextAutomaticStep: running
        ? `Pin&Go is processing automatic attempt ${Math.min(
            input.attemptCount + 1,
            input.maxAttempts
          )} of ${input.maxAttempts}.`
        : input.nextAttemptAt
        ? `Pin&Go will retry the PMS event at ${input.nextAttemptAt.toISOString()}.`
        : "Pin&Go will retry the PMS event automatically.",

      engine: "DISTRIBUTION_PMS",
      severity: "WARNING",
      workflowState: running
        ? "AUTO_RESOLVING"
        : "WAITING",
      visibility: "HOST",
      responsibleActor: "PIN_GO",

      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: running
        ? "RUNNING"
        : "AVAILABLE",
      autoResolveActionCode:
        "RETRY_PMS_INGEST",

      organizationId:
        input.organizationId,
      propertyId: null,
      reservationId: null,

      decisionId:
        `pms-ingest-recovery:${input.eventId}`,
      sourceType: "WORKER",
      actionTarget: "DISTRIBUTION",

      metadata: {
        eventId: input.eventId,
        connectionId:
          input.connectionId,
        provider: input.provider,
        eventType: input.eventType,
        attempt:
          input.attemptCount,
        maxAttempts:
          input.maxAttempts,
        nextAttemptAt:
          input.nextAttemptAt
            ?.toISOString() ?? null,
        exhausted: false,
        lastError:
          input.lastError,
      },

      transitionCode: running
        ? "PMS_INGEST_RECOVERY_STARTED"
        : "PMS_INGEST_RETRY_SCHEDULED",
      transitionSummary: running
        ? "Distribution / PMS started the next automatic ingest recovery attempt."
        : "Distribution / PMS retained ownership and scheduled the next automatic ingest recovery attempt.",
      transitionedBy: "PIN_GO",
      occurredAt:
        input.occurredAt,
      lastSignalAt:
        input.occurredAt,
    }
  );
}

async function resolveRecoveryState(
  prisma: PrismaClient,
  input: Omit<
    PmsIngestRecoveryEventContext,
    "state" | "nextAttemptAt"
  >
) {
  const operationalKey =
    buildOperationalKey(input.eventId);

  const existing =
    await prisma.operationalIssue.findUnique({
      where: {
        operationalKey,
      },
      select: {
        workflowState: true,
      },
    });

  if (
    !existing ||
    existing.workflowState === "RESOLVED"
  ) {
    return;
  }

  await upsertOperationalIssue(
    prisma,
    {
      operationalKey,
      issueCode:
        "PMS_INGEST_RECOVERED",
      title:
        "PMS event recovered",
      issue:
        `Pin&Go processed the ${input.provider || "PMS"} event after automatic recovery.`,
      operationalImpact: null,
      recommendedAction: null,
      nextAutomaticStep: null,

      engine: "DISTRIBUTION_PMS",
      severity: "INFO",
      workflowState: "RESOLVED",
      visibility: "HOST",
      responsibleActor: "NONE",

      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "SUCCEEDED",
      autoResolveActionCode: null,

      organizationId:
        input.organizationId,
      propertyId: null,
      reservationId: null,

      decisionId:
        `pms-ingest-recovery:${input.eventId}`,
      sourceType: "WORKER",
      actionTarget: "DISTRIBUTION",

      resolvedAt:
        input.occurredAt,
      resolutionCode:
        "PMS_INGEST_RECOVERY_SUCCEEDED",
      resolutionSummary:
        "Pin&Go completed PMS ingestion without host intervention.",
      resolutionType: "AUTOMATIC",
      resolvedBy: "PIN_GO",

      metadata: {
        eventId: input.eventId,
        connectionId:
          input.connectionId,
        provider: input.provider,
        eventType: input.eventType,
        attempt:
          input.attemptCount,
        maxAttempts:
          input.maxAttempts,
        exhausted: false,
        recoveredAt:
          input.occurredAt.toISOString(),
      },

      transitionCode:
        "PMS_INGEST_RECOVERY_SUCCEEDED",
      transitionSummary:
        "Distribution / PMS processed the event and resolved the ingest recovery workflow automatically.",
      transitionedBy: "PIN_GO",
      occurredAt:
        input.occurredAt,
      lastSignalAt:
        input.occurredAt,
    }
  );
}

function buildCandidateContext(
  event: RecoveryCandidate,
  maxAttempts: number,
  state: PmsIngestRecoveryState,
  nextAttemptAt: Date | null,
  occurredAt: Date
) {
  return toContext({
    event,
    maxAttempts,
    state,
    nextAttemptAt,
    occurredAt,
  });
}

export async function processPmsIngestRecovery(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: PmsIngestRecoveryOptions = {}
): Promise<PmsIngestRecoveryResult> {
  const maxAttempts =
    normalizePositiveInteger(
      options.maxAttempts ??
        process.env
          .PMS_INGEST_RECOVERY_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS
    );
  const batchSize =
    normalizePositiveInteger(
      options.batchSize ??
        process.env
          .PMS_INGEST_RECOVERY_BATCH_SIZE,
      DEFAULT_BATCH_SIZE
    );
  const staleProcessingMs =
    normalizeNonNegativeInteger(
      options.staleProcessingMs ??
        process.env
          .PMS_INGEST_RECOVERY_STALE_PROCESSING_MS,
      DEFAULT_STALE_PROCESSING_MS
    );

  const processEvent =
    options.processEvent ??
    processWebhookEventById;
  const recordState =
    options.recordState ??
    ((input) =>
      persistRecoveryState(
        prisma,
        input
      ));
  const resolveState =
    options.resolveState ??
    ((input) =>
      resolveRecoveryState(
        prisma,
        input
      ));

  const result: PmsIngestRecoveryResult = {
    staleReleased: 0,
    scanned: 0,
    attempted: 0,
    recovered: 0,
    scheduled: 0,
    running: 0,
    exhausted: 0,
    failed: 0,
  };

  const staleBefore = new Date(
    now.getTime() - staleProcessingMs
  );

  const staleEvents =
    await prisma.webhookEventIngest.findMany({
      where: {
        status: "PROCESSING",
        updatedAt: {
          lte: staleBefore,
        },
      },
      orderBy: {
        updatedAt: "asc",
      },
      take: batchSize,
      select: {
        id: true,
      },
    });

  for (const staleEvent of staleEvents) {
    const released =
      await prisma.webhookEventIngest.updateMany({
        where: {
          id: staleEvent.id,
          status: "PROCESSING",
          updatedAt: {
            lte: staleBefore,
          },
        },
        data: {
          status: "FAILED",
          lastError:
            "PMS_INGEST_PROCESSING_LEASE_EXPIRED",
        },
      });

    result.staleReleased +=
      released.count;
  }

  const candidates =
    await prisma.webhookEventIngest.findMany({
      where: {
        status: {
          in: ["PENDING", "FAILED"],
        },
      },
      orderBy: {
        updatedAt: "asc",
      },
      take: batchSize,
      select: {
        id: true,
        connectionId: true,
        provider: true,
        eventType: true,
        status: true,
        attempts: true,
        lastError: true,
        receivedAt: true,
        updatedAt: true,
        connection: {
          select: {
            organizationId: true,
            status: true,
          },
        },
      },
    }) as RecoveryCandidate[];

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    try {
      if (
        candidate.attempts >= maxAttempts
      ) {
        await recordState(
          buildCandidateContext(
            candidate,
            maxAttempts,
            "EXHAUSTED",
            null,
            now
          )
        );
        result.exhausted += 1;
        continue;
      }

      const nextAttemptAt =
        getPmsIngestRecoveryNextAttemptAt(
          candidate.updatedAt,
          candidate.attempts
        );

      if (nextAttemptAt > now) {
        await recordState(
          buildCandidateContext(
            candidate,
            maxAttempts,
            "WAITING",
            nextAttemptAt,
            now
          )
        );
        result.scheduled += 1;
        continue;
      }

      await recordState(
        buildCandidateContext(
          candidate,
          maxAttempts,
          "RUNNING",
          null,
          now
        )
      );

      result.attempted += 1;

      try {
        await processEvent(candidate.id);
      } catch (error) {
        const errorMessage =
          toErrorMessage(error);

        await prisma.webhookEventIngest.updateMany({
          where: {
            id: candidate.id,
            status: {
              in: ["PENDING", "PROCESSING"],
            },
          },
          data: {
            status: "FAILED",
            lastError: errorMessage,
          },
        });
      }

      const current =
        await prisma.webhookEventIngest.findUnique({
          where: {
            id: candidate.id,
          },
          select: {
            id: true,
            connectionId: true,
            provider: true,
            eventType: true,
            status: true,
            attempts: true,
            lastError: true,
            receivedAt: true,
            updatedAt: true,
            connection: {
              select: {
                organizationId: true,
                status: true,
              },
            },
          },
        }) as RecoveryCandidate | null;

      if (!current) {
        result.failed += 1;
        continue;
      }

      if (current.status === "PROCESSED") {
        const context =
          buildCandidateContext(
            current,
            maxAttempts,
            "RUNNING",
            null,
            now
          );

        await resolveState({
          eventId: context.eventId,
          connectionId:
            context.connectionId,
          organizationId:
            context.organizationId,
          provider: context.provider,
          eventType: context.eventType,
          attemptCount:
            context.attemptCount,
          maxAttempts:
            context.maxAttempts,
          lastError:
            context.lastError,
          occurredAt: now,
        });

        result.recovered += 1;
        continue;
      }

      if (current.status === "PROCESSING") {
        await recordState(
          buildCandidateContext(
            current,
            maxAttempts,
            "RUNNING",
            null,
            now
          )
        );
        result.running += 1;
        continue;
      }

      if (
        current.status === "FAILED" &&
        current.attempts >= maxAttempts
      ) {
        await recordState(
          buildCandidateContext(
            current,
            maxAttempts,
            "EXHAUSTED",
            null,
            now
          )
        );
        result.exhausted += 1;
        continue;
      }

      const retryAt =
        current.status === "PENDING"
          ? new Date(
              now.getTime() +
                DEFAULT_PENDING_RECHECK_MS
            )
          : getPmsIngestRecoveryNextAttemptAt(
              current.updatedAt,
              current.attempts
            );

      await recordState(
        buildCandidateContext(
          current,
          maxAttempts,
          "WAITING",
          retryAt,
          now
        )
      );
      result.scheduled += 1;
    } catch (error) {
      result.failed += 1;

      console.error(
        "[PMS_INGEST_RECOVERY_ERROR]",
        {
          eventId: candidate.id,
          connectionId:
            candidate.connectionId,
          provider:
            String(candidate.provider),
          attempts:
            candidate.attempts,
          error:
            toErrorMessage(error),
        }
      );
    }
  }

  return result;
}
