import {
  runChannexAriDispatchCycle,
  type ChannexAriDispatchCycleDb,
} from "./channex-ari-dispatch-cycle.service";
import type { ChannexAriHttpTransport } from "./channex-ari-http.client";
import {
  materializeNextChannexAriOutboxBatch,
  type ChannexAriOutboxMaterializerDb,
} from "./channex-ari-outbox-materializer.service";

export type ChannexAriOutboundCycleDb =
  ChannexAriOutboxMaterializerDb & ChannexAriDispatchCycleDb;

export type RunChannexAriOutboundCycleInput = {
  db: ChannexAriOutboundCycleDb;
  selectionLimit: number;
  candidateScanLimit: number;
  leaseMs: number;
  timeoutMs: number;
  completionReserveMs: number;
  jitterMs: number;
  credentialsSecret?: string;
  globalApiKey?: string;
  baseUrl?: string;
  transport?: ChannexAriHttpTransport;
  clock?: () => Date;
  claimTokenFactory?: () => string;
  materialize?: typeof materializeNextChannexAriOutboxBatch;
  dispatch?: typeof runChannexAriDispatchCycle;
};

function readClock(clock: (() => Date) | undefined, errorCode: string): Date {
  const now = new Date(clock ? clock() : new Date());

  if (Number.isNaN(now.getTime())) {
    throw new Error(errorCode);
  }

  return now;
}

function publicErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? String(error.message ?? "").trim() : "";

  return /^[A-Z0-9_]+$/.test(message) && message.length <= 128
    ? message
    : "CHANNEX_ARI_OUTBOUND_MATERIALIZATION_FAILED";
}

export async function runChannexAriOutboundCycle(
  input: RunChannexAriOutboundCycleInput
) {
  const materialize = input.materialize ?? materializeNextChannexAriOutboxBatch;
  const dispatch = input.dispatch ?? runChannexAriDispatchCycle;
  const cycleStartedAt = readClock(
    input.clock,
    "CHANNEX_ARI_OUTBOUND_CYCLE_STARTED_AT_INVALID"
  );
  let materialization: Awaited<ReturnType<typeof materializeNextChannexAriOutboxBatch>> | {
    outcome: "FAILED_BEFORE_CLAIM";
    startedAt: Date;
    errorCode: string;
  };

  try {
    materialization = await materialize({
      db: input.db,
      now: cycleStartedAt,
      claimLeaseMs: input.leaseMs,
      claimLimit: input.selectionLimit,
      recoveryLimit: input.selectionLimit,
      jitterMs: input.jitterMs,
      claimTokenFactory: input.claimTokenFactory,
      clock: input.clock,
    });
  } catch (error) {
    materialization = {
      outcome: "FAILED_BEFORE_CLAIM",
      startedAt: cycleStartedAt,
      errorCode: publicErrorCode(error),
    };
  }

  const dispatchStartedAt = readClock(
    input.clock,
    "CHANNEX_ARI_OUTBOUND_DISPATCH_STARTED_AT_INVALID"
  );

  if (dispatchStartedAt.getTime() < cycleStartedAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOUND_CLOCK_MOVED_BACKWARD");
  }

  const dispatchResult = await dispatch({
    db: input.db,
    selection: {
      now: dispatchStartedAt,
      limit: input.selectionLimit,
      candidateScanLimit: input.candidateScanLimit,
    },
    credentialsSecret: input.credentialsSecret,
    globalApiKey: input.globalApiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    jitterMs: input.jitterMs,
    leaseMs: input.leaseMs,
    completionReserveMs: input.completionReserveMs,
    transport: input.transport,
    clock: input.clock,
  });

  return {
    cycleStartedAt,
    dispatchStartedAt,
    materialization,
    dispatch: dispatchResult,
  };
}
