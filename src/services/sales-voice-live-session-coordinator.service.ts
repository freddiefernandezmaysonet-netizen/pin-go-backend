import type { PrismaClient } from "@prisma/client";
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
  | "CONFIRMED_CLOSED"
  | "HANGUP_SENT_AWAITING_CLOSE"
  | "HANGUP_UNKNOWN_AWAITING_RECONCILIATION"
  | "PREVIOUS_HANGUP_OR_CLOSE";

export type CoordinatorResult =
  | { state: "ALREADY_CLAIMED" | "ACCEPT_UNKNOWN"; completion?: never; disconnect?: never }
  | {
    state: "MONITORING" | "SIDE_BAND_CONNECT_FAILED";
    completion: Promise<CoordinatorCompletion>;
    disconnect: () => void;
  };

/** One durable hangup claim, one provider request, never a blind retry. */
async function fenceHangup(
  watchdog: SalesVoiceLiveWatchdog,
  sessionId: string,
  apiKey: string,
  hangupTransport: HangupHTTP,
): Promise<CoordinatorCompletion> {
  let decision: "CLAIMED" | "ALREADY_HELD";
  try {
    decision = await watchdog.claimHangup(sessionId);
  } catch {
    return "HANGUP_UNKNOWN_AWAITING_RECONCILIATION";
  }
  if (decision !== "CLAIMED") return "PREVIOUS_HANGUP_OR_CLOSE";
  let acknowledged = false;
  try {
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

  const watchdog = new SalesVoiceLiveWatchdog(input.db);
  // Provider acceptance precedes sideband attach per the Live SIP contract.
  let session: Awaited<ReturnType<typeof observeExistingLiveSession>>;
  try {
    session = await observeExistingLiveSession({
      db: input.db,
      sessionId: input.sessionId,
      apiKey: input.apiKey,
      enabled: true,
      connect: input.sidebandConnect,
    });
  } catch {
    // Provider may already be speaking to the caller. End it once; never
    // claim that a failed /attach proves the provider has disconnected.
    const completion = fenceHangup(
      watchdog, input.sessionId, input.apiKey, input.hangupTransport,
    );
    return {
      state: "SIDE_BAND_CONNECT_FAILED",
      completion,
      disconnect: () => undefined,
    };
  }

  const completion = session.completion.then(
    async (result: SidebandSessionResult): Promise<CoordinatorCompletion> => {
      if (result.state === "CONFIRMED_CLOSED") return "CONFIRMED_CLOSED";
      return fenceHangup(watchdog, input.sessionId, input.apiKey, input.hangupTransport);
    },
    async (): Promise<CoordinatorCompletion> =>
      fenceHangup(watchdog, input.sessionId, input.apiKey, input.hangupTransport),
  );
  return {
    state: "MONITORING",
    completion,
    disconnect: session.disconnect,
  };
}
