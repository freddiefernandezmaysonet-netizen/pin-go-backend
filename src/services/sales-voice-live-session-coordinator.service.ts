import type { PrismaClient, Prisma } from "@prisma/client";
import { SalesVoiceRecoveryLease, type RecoveryLease } from "./sales-voice-recovery-lease.service.js";
import { SalesVoiceRecoveryOwnershipLost } from "./sales-voice-recovery-observation.service.js";
import {
  SalesVoiceLiveAdmission, attemptOneLiveAccept,
  type AdmissionLimits, type ProviderHTTP,
} from "./sales-voice-live-admission.service.js";
import {
  observeExistingLiveSession,
  type SidebandSocketFactory, type SidebandSessionResult,
} from "./sales-voice-sideband-supervisor.service.js";
import {
  SalesVoiceLiveWatchdog, postOneLiveHangup, type HangupHTTP,
} from "./sales-voice-live-watchdog.service.js";

/**
 * FIRST-CLASS TEST HARNESS for existing GPT-Live SIP components.
 *
 * Invoke ONLY after the signed inbound webhook has separately persisted a
 * verified OPENAI_LIVE_SIP session. This module is deliberately NOT mounted
 * by src/server.ts or invoked by a production worker.
 *
 * No default network clients are provided: an explicit test transport is
 * required for every provider operation. NODE_ENV=test and the named
 * certification environment are mandatory; deployment to production cannot
 * accidentally enable it through a boolean alone.
 *
 * Even if provider accepted a session, WebSocket loss is not proof of end:
 * request one fenced hangup, retain the capacity slot until session.closed.
 */
type Db = Pick<PrismaClient, "$transaction" | "salesVoiceCall">;
type Env = Readonly<Record<string, string | undefined>>;

export class SalesVoiceCoordinationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesVoiceCoordinationError";
  }
}
const reject = (code: string): never => {
  throw new SalesVoiceCoordinationError(code);
};
const permitted = (env: Env): boolean =>
  env.NODE_ENV === "test"
  && env.RAILWAY_ENVIRONMENT_NAME === "sales-voice-certification"
  && env.SALES_VOICE_SESSION_COORDINATOR_SIMULATION_ENABLED === "true"
  && env.SALES_VOICE_SESSION_COORDINATOR_RELEASE_CERTIFIED === "true";

export type CoordinatorCompletion =
  | "OBSERVER_STOPPED"
  | "OWNERSHIP_LOST"
  | "CONFIRMED_CLOSED"
  | "HANGUP_SENT_AWAITING_CLOSE"
  | "HANGUP_UNKNOWN_AWAITING_RECONCILIATION"
  | "PREVIOUS_HANGUP_OR_CLOSE";

type ObservableResult = {
  completion: Promise<CoordinatorCompletion>;
  disconnect: () => void;
  renewOwnership: () => Promise<boolean>;
};
export type CoordinatorResult =
  | { state: "ALREADY_CLAIMED" | "ACCEPT_UNKNOWN" | "RECOVERY_OWNERSHIP_UNAVAILABLE"; completion?: never; disconnect?: never }
  | ({ state: "MONITORING" } & ObservableResult)
  | ({ state: "SIDE_BAND_CONNECT_FAILED" } & ObservableResult);

/**
 * Lock before reading DB time: takeover, renewal and callback hangup claims
 * share the same owner/epoch boundary. No provider request runs in this lock.
 */
async function withObserverOwnership<T>(
  db: Db, lease: RecoveryLease,
  action: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
): Promise<T> {
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>
      `SELECT "id" FROM "SalesVoiceCall"
       WHERE "providerCallId" = ${lease.sessionId} FOR UPDATE`;
    const [time] = await tx.$queryRaw<Array<{ now: Date }>>
      `SELECT clock_timestamp() AS "now"`;
    const row = await tx.salesVoiceCall.findUnique({where:{providerCallId:lease.sessionId}});
    if (!(time?.now instanceof Date) || !Number.isFinite(time.now.getTime())) {
      throw new Error("OBSERVER_DATABASE_CLOCK_REQUIRED");
    }
    if (locked.length !== 1 || !row || row.finalizedAt
      || row.provider !== "OPENAI_LIVE_SIP" || row.direction !== "INBOUND"
      || row.recoveryLeaseOwner !== lease.owner || row.recoveryLeaseEpoch !== lease.epoch
      || !row.recoveryLeaseUntil || row.recoveryLeaseUntil.getTime() <= time.now.getTime()) {
      throw new SalesVoiceRecoveryOwnershipLost();
    }
    const result = await action(tx, time.now);
    const [end] = await tx.$queryRaw<Array<{ now: Date }>>
      `SELECT clock_timestamp() AS "now"`;
    if (!(end?.now instanceof Date) || !Number.isFinite(end.now.getTime())
      || row.recoveryLeaseUntil.getTime() <= end.now.getTime()) {
      throw new SalesVoiceRecoveryOwnershipLost();
    }
    return result;
  }, {maxWait:2000,timeout:5000});
}

/** One durable hangup claim, one provider request, never a blind retry. */
async function fenceHangup(
  db: Db,
  lease: RecoveryLease,
  apiKey: string,
  hangupTransport: HangupHTTP,
  active: () => boolean,
): Promise<CoordinatorCompletion> {
  const sessionId = lease.sessionId;
  const watchdog = new SalesVoiceLiveWatchdog(db);
  if (!active()) return "OBSERVER_STOPPED";
  let decision: "CLAIMED" | "ALREADY_HELD";
  try {
    decision = await withObserverOwnership(db, lease, async (tx, now) => {
      if (!active()) throw new Error("OBSERVER_STOPPED");
      return new SalesVoiceLiveWatchdog(tx).claimHangup(sessionId, now);
    });
  } catch (error) {
    if (!active()) return "OBSERVER_STOPPED";
    if (error instanceof SalesVoiceRecoveryOwnershipLost) return "OWNERSHIP_LOST";
    return "HANGUP_UNKNOWN_AWAITING_RECONCILIATION";
  }
  if (decision !== "CLAIMED") return "PREVIOUS_HANGUP_OR_CLOSE";
  let acknowledged = false;
  try {
    if (!active()) return "OBSERVER_STOPPED";
    await postOneLiveHangup({
      sessionId, apiKey, transport: hangupTransport, enabled: true,
    });
    acknowledged = true;
  } catch {
    // A timeout or network failure is ambiguous, never repeat /hangup.
  }
  try {
    await watchdog.recordHangupResult(sessionId, acknowledged);
  } catch {
    return "HANGUP_UNKNOWN_AWAITING_RECONCILIATION";
  }
  return acknowledged
    ? "HANGUP_SENT_AWAITING_CLOSE"
    : "HANGUP_UNKNOWN_AWAITING_RECONCILIATION";
}

export async function coordinateSimulatedLiveSipSession(input: {
  db: Db;
  env: Env;
  sessionId: string;
  apiKey: string;
  limits: AdmissionLimits;
  observerOwner: string;
  observerTtlSeconds: number;
  acceptTransport: ProviderHTTP;
  hangupTransport: HangupHTTP;
  sidebandConnect: SidebandSocketFactory;
}): Promise<CoordinatorResult> {
  if (!permitted(input.env)) reject("PRODUCTION_AND_RELEASE_VETO");
  if (!input.apiKey?.startsWith("sk-")
      || typeof input.acceptTransport !== "function"
      || typeof input.hangupTransport !== "function"
      || typeof input.sidebandConnect !== "function") {
    reject("TRUSTED_TRANSPORTS_AND_KEY_REQUIRED");
  }

  if (!/^voice_[A-Za-z0-9_-]{12,70}$/.test(input.observerOwner)
      || !Number.isSafeInteger(input.observerTtlSeconds)
      || input.observerTtlSeconds < 10 || input.observerTtlSeconds > 120) {
    reject("VALID_OBSERVER_OWNERSHIP_REQUIRED");
  }

  input = { ...input, limits: { ...input.limits } }; // snapshot validated configuration

  // One owner of admission + /accept. A separately claimed slot cannot
  // be accepted again here: ALREADY_CLAIMED is a hard no-op.
  const admission = new SalesVoiceLiveAdmission(input.db);
  const state = await attemptOneLiveAccept({
    admission,
    sessionId: input.sessionId,
    limits: input.limits,
    apiKey: input.apiKey,
    transport: input.acceptTransport,
    explicitlyEnabled: true,
  });
  if (state !== "ACCEPTED") return { state };

  // Acquire the initial observer through the SAME persisted epoch/owner fence
  // used after restart. No inventory delay between acceptance and attach.
  // Failure preserves capacity and delegates duration enforcement to the guardian.
  let lease = await input.db.$transaction(async tx => {
    const [time] = await tx.$queryRaw<Array<{ now: Date }>>
      `SELECT clock_timestamp() AS "now"`;
    if (!(time?.now instanceof Date) || !Number.isFinite(time.now.getTime())) {
      throw new Error("OBSERVER_DATABASE_CLOCK_REQUIRED");
    }
    return new SalesVoiceRecoveryLease(tx).claim({
      sessionId: input.sessionId, owner: input.observerOwner,
      ttlSeconds: input.observerTtlSeconds, now: time.now,
    });
  }).catch(() => null);
  if (!lease) return { state: "RECOVERY_OWNERSHIP_UNAVAILABLE" };

  let stopReason: "OBSERVER_STOPPED" | "OWNERSHIP_LOST" | null = null;
  let settled = false;
  const active = () => stopReason === null && permitted(input.env);
  // Provider acceptance precedes sideband attach per the Live SIP contract.
  let session: Awaited<ReturnType<typeof observeExistingLiveSession>>;
  try {
    session = await observeExistingLiveSession({
      db: input.db,
      sessionId: input.sessionId,
      apiKey: input.apiKey,
      enabled: true,
      connect: (url, options) => {
        if (!active()) throw new Error("OBSERVER_STOPPED");
        return input.sidebandConnect(url, options);
      },
      recoveryLease: lease,
    });
  } catch (error) {
    if (error instanceof SalesVoiceRecoveryOwnershipLost) {
      return { state: "RECOVERY_OWNERSHIP_UNAVAILABLE" };
    }
    // Provider may already be speaking to the caller. End it once; never
    // claim that a failed /attach proves the provider has disconnected.
    const completion = fenceHangup(
      input.db, lease, input.apiKey, input.hangupTransport, active,
    );
    return {
      state: "SIDE_BAND_CONNECT_FAILED",
      completion,
      disconnect: () => { stopReason = "OBSERVER_STOPPED"; },
      renewOwnership: async () => false,
    };
  }

  const disconnect = () => {
    stopReason ??= "OBSERVER_STOPPED";
    session.disconnect(); // local close, no provider hangup or capacity release
  };
  let renewal: Promise<boolean> | undefined;
  const renewOwnership = (): Promise<boolean> => {
    if (renewal) return renewal; // concurrent heartbeats share one renewal
    renewal = (async () => {
      if (settled || !active()) { disconnect(); return false; }
      try {
        const renewed = await withObserverOwnership(input.db, lease!, async (tx, now) => {
          if (!active()) throw new Error("OBSERVER_STOPPED");
          return new SalesVoiceRecoveryLease(tx).renew(lease!, now, input.observerTtlSeconds);
        });
        if (!renewed) throw new SalesVoiceRecoveryOwnershipLost();
        if (settled || !active()) { disconnect(); return false; }
        lease = renewed; // persisted epoch remains unchanged; observer checks DB expiry
        return true;
      } catch {
        stopReason ??= permitted(input.env) ? "OWNERSHIP_LOST" : "OBSERVER_STOPPED";
        session.disconnect();
        return false;
      }
    })().finally(() => { renewal = undefined; });
    return renewal;
  };
  const finish = async (result?: SidebandSessionResult): Promise<CoordinatorCompletion> => {
    settled = true;
    if (result?.state === "CONFIRMED_CLOSED") return "CONFIRMED_CLOSED";
    if (result?.state === "OWNERSHIP_LOST") return "OWNERSHIP_LOST";
    if (stopReason) return stopReason;
    if (!permitted(input.env)) return "OBSERVER_STOPPED";
    return fenceHangup(input.db, lease!, input.apiKey, input.hangupTransport, active);
  };
  const completion = session.completion.then(finish, () => finish());
  if (!active()) disconnect();
  return { state: "MONITORING", completion, disconnect, renewOwnership };
}
