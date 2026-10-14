import type { PrismaClient, SalesVoiceCall } from "@prisma/client";

// Draft-only. No public route, worker schedule, WebSocket, Twilio integration,
// sideband transport, provider credentials or actual telephone call enabled.
// Caller MUST use a trusted sideband attachment bound to a verified session ID.
const RUNNING = ["ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN"] as const;
const HELD = [...RUNNING, "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN"] as const;
const END_REASONS = [
  "close_requested", "expired", "content", "remote_hangup", "connection_lost",
] as const;

export class SalesVoiceWatchdogError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesVoiceWatchdogError";
  }
}
const fail = (code: string): never => { throw new SalesVoiceWatchdogError(code); };
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function id(value: string): string {
  if (typeof value !== "string" || !/^live_[a-zA-Z0-9_-]{1,123}$/.test(value)) {
    return fail("INVALID_SESSION_ID");
  }
  return value;
}
function usageSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 604800) {
    return fail("INVALID_USAGE");
  }
  return value;
}
function timestamp(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("INVALID_TIME");
  return value;
}

export type SidebandObservation =
  | { type: "usage"; sessionId: string; eventId: string; seconds: number }
  | { type: "closed"; sessionId: string; eventId: string; seconds: number; reason: typeof END_REASONS[number] };

/**
 * The sideband connection itself supplies the authoritative session binding.
 * session.usage.updated has no session_id; never allow a webhook caller to
 * provide an arbitrary binding to this parser.
 */
export function parseBoundLiveSidebandEvent(value: unknown, boundSessionId: string): SidebandObservation | null {
  id(boundSessionId);
  if (!isRecord(value)) return fail("INVALID_SIDEBAND_EVENT");
  if (value.type !== "session.usage.updated" && value.type !== "session.closed") return null;
  if (typeof value.event_id !== "string" || value.event_id.length < 1 || value.event_id.length > 256) {
    return fail("INVALID_EVENT_ID");
  }
  if (!isRecord(value.usage)) return fail("MISSING_USAGE");
  const seconds = usageSeconds(value.usage.seconds);

  if (value.type === "session.usage.updated") {
    return { type: "usage", sessionId: boundSessionId, eventId: value.event_id, seconds };
  }
  if (!isRecord(value.session) || value.session.id !== boundSessionId) {
    return fail("SIDEBAND_SESSION_MISMATCH");
  }
  const reason = value.reason;
  if (!END_REASONS.includes(reason as typeof END_REASONS[number])) {
    return fail("INVALID_CLOSE_REASON");
  }
  return { type: "closed", sessionId: boundSessionId, eventId: value.event_id,
    seconds, reason: reason as typeof END_REASONS[number] };
}

type Db = Pick<PrismaClient, "salesVoiceCall">;
function assertLive(call: SalesVoiceCall | null): asserts call is SalesVoiceCall {
  if (!call || call.provider !== "OPENAI_LIVE_SIP" || call.direction !== "INBOUND") {
    fail("VERIFIED_LIVE_CALL_REQUIRED");
  }
}

/**
 * Voice duration is cumulative (not per-event incremental). A late or
 * replayed lower update must never decrease observed usage.
 */
export async function noteLiveUsage(db: Db, observation: Extract<SidebandObservation, {type: "usage"}>,
  now: Date = new Date()): Promise<SalesVoiceCall> {
  id(observation.sessionId);
  timestamp(now);
  usageSeconds(observation.seconds);
  const call = await db.salesVoiceCall.findUnique({ where: { providerCallId: observation.sessionId } });
  assertLive(call);
  if (call.finalizedAt) return call;

  await db.salesVoiceCall.updateMany({
    where: {
      id: call.id, finalizedAt: null,
      status: { in: [...HELD] },
      OR: [{ lastUsageSeconds: null }, { lastUsageSeconds: { lt: observation.seconds } }],
    },
    data: { lastUsageSeconds: observation.seconds, usageObservedAt: now },
  });
  return db.salesVoiceCall.findUniqueOrThrow({ where: { id: call.id } });
}

/**
 * Release a slot ONLY when session.closed is observed on the matching trusted
 * sideband. A TCP disconnect, HTTP 200 to /hangup, or elapsed timeout cannot
 * manufacture this proof. First consistent final event wins.
 */
export async function finalizeLiveClosed(db: Db, observation: Extract<SidebandObservation, {type: "closed"}>,
  now: Date = new Date()): Promise<SalesVoiceCall> {
  id(observation.sessionId);
  timestamp(now);
  usageSeconds(observation.seconds);
  if (!END_REASONS.includes(observation.reason)) fail("INVALID_CLOSE_REASON");
  const call = await db.salesVoiceCall.findUnique({ where: { providerCallId: observation.sessionId } });
  assertLive(call);
  if (call.finalizedAt) {
    if (call.closeReason !== observation.reason || call.finalUsageSeconds !== observation.seconds) {
      fail("CONFLICTING_FINAL_EVENT");
    }
    return call;
  }
  if (call.lastUsageSeconds !== null && observation.seconds + 0.001 < call.lastUsageSeconds) {
    fail("FINAL_USAGE_BELOW_OBSERVED");
  }
  const elapsed = Math.max(0, Math.floor((now.getTime() - call.startedAt.getTime()) / 1000));
  // Include the observed-usage bound in the same database compare-and-set
  // to fence usage updates that race between the initial read and finalization.
  await db.salesVoiceCall.updateMany({
    where: {
      id: call.id, finalizedAt: null, status: { in: ["RECEIVED", ...HELD] },
      OR: [{ lastUsageSeconds: null }, { lastUsageSeconds: { lte: observation.seconds + 0.001 } }],
    },
    data: {
      status: "COMPLETED", finalUsageSeconds: observation.seconds,
      lastUsageSeconds: observation.seconds, usageObservedAt: now,
      finalizedAt: now, endedAt: now, closeReason: observation.reason,
      durationSeconds: elapsed,
    },
  });
  const stored = await db.salesVoiceCall.findUniqueOrThrow({ where: { id: call.id } });
  if (!stored.finalizedAt) {
    if (stored.lastUsageSeconds !== null && observation.seconds + 0.001 < stored.lastUsageSeconds) {
      fail("FINAL_USAGE_BELOW_OBSERVED");
    }
    fail("FINALIZATION_NOT_CONFIRMED");
  }
  if (stored.finalUsageSeconds !== observation.seconds
    || stored.closeReason !== observation.reason) fail("CONFLICTING_FINAL_EVENT");
  return stored;
}

export type HangupHTTP = (
  url: string, request: { method: "POST"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number }>;

/** One attempt only; a successful POST means initiated hangup, not final closure. */
export async function postOneLiveHangup(input: {
  sessionId: string; apiKey: string; transport: HangupHTTP; enabled: boolean;
}): Promise<void> {
  id(input.sessionId);
  if (!input.enabled) fail("HANGUP_DISABLED");
  if (!input.apiKey?.startsWith("sk-")) fail("API_KEY_REQUIRED");
  const result = await input.transport(
    "https://api.openai.com/v1/live/sessions/" + encodeURIComponent(input.sessionId) + "/hangup",
    { method: "POST", headers: { Authorization: "Bearer " + input.apiKey },
      signal: AbortSignal.timeout(5000) },
  );
  if (result.status !== 200) fail("HANGUP_UNCONFIRMED");
}

export type WatchdogPolicy = {
  enabled: boolean;
  maxCallSeconds: number;
  batchSize: number;
  certificationWindow?: Readonly<{ startsAtMs: number; endsAtMs: number }>;
};
function policy(p: WatchdogPolicy): void {
  const window = p.certificationWindow;
  if (window && (!Number.isSafeInteger(window.startsAtMs) || window.startsAtMs <= 0
    || !Number.isSafeInteger(window.endsAtMs) || window.endsAtMs <= window.startsAtMs
    || window.endsAtMs - window.startsAtMs > 15 * 60 * 1000))
    fail("INVALID_CERTIFICATION_WINDOW");
  if (!p.enabled) fail("WATCHDOG_DISABLED");
  if (!Number.isSafeInteger(p.maxCallSeconds) || p.maxCallSeconds < 60
    || p.maxCallSeconds > 3600 || !Number.isSafeInteger(p.batchSize)
    || p.batchSize < 1 || p.batchSize > 25) fail("INVALID_WATCHDOG_POLICY");
}

export class SalesVoiceLiveWatchdog {
  constructor(private readonly db: Db) {}

  /**
   * Atomic state transition fences a single /hangup request across workers.
   * If a worker crashes after claiming, the state stays HANGUP_CLAIMED and
   * requires verified reconciliation, never an unsafe blind replay.
   */
  async claimHangup(sessionId: string, now = new Date()): Promise<"CLAIMED" | "ALREADY_HELD"> {
    id(sessionId);
    timestamp(now);
    const result = await this.db.salesVoiceCall.updateMany({
      where: { providerCallId: sessionId, provider: "OPENAI_LIVE_SIP",
        direction: "INBOUND", finalizedAt: null, status: { in: [...RUNNING] },
        hangupClaimedAt: null },
      data: { status: "HANGUP_CLAIMED", hangupClaimedAt: now },
    });
    if (result.count === 1) return "CLAIMED";
    const existing = await this.db.salesVoiceCall.findUnique({ where: { providerCallId: sessionId } });
    assertLive(existing);
    if (existing.finalizedAt || existing.status === "COMPLETED") return "ALREADY_HELD";
    if (HELD.includes(existing.status as typeof HELD[number])) return "ALREADY_HELD";
    return fail("HANGUP_NOT_ALLOWED");
  }

  async recordHangupResult(sessionId: string, succeeded: boolean, now = new Date()): Promise<SalesVoiceCall> {
    id(sessionId);
    timestamp(now);
    const res = await this.db.salesVoiceCall.updateMany({
      where: { providerCallId: sessionId, provider: "OPENAI_LIVE_SIP",
        status: "HANGUP_CLAIMED", finalizedAt: null },
      data: succeeded
        ? { status: "HANGUP_SENT", hangupAcknowledgedAt: now }
        : { status: "HANGUP_UNKNOWN" },
    });
    if (res.count !== 1) {
      const current = await this.db.salesVoiceCall.findUnique({ where: { providerCallId: sessionId } });
      assertLive(current);
      if (current.finalizedAt) return current; // session.closed won the race
      return fail("HANGUP_OUTCOME_CONFLICT");
    }
    return this.db.salesVoiceCall.findUniqueOrThrow({ where: { providerCallId: sessionId } });
  }

  /**
   * Callable once from a FUTURE separately certified, scheduled worker.
   * Does not schedule itself. Every invocation requires explicit enablement,
   * valid credential, bounded queries, and injected transport.
   */
  async runOnce(input: {
    policy: WatchdogPolicy; apiKey: string; transport: HangupHTTP; now?: Date;
  }): Promise<{ inspected: number; claimed: number; sent: number; unknown: number }> {
    policy(input.policy);
    if (!input.apiKey?.startsWith("sk-")) fail("API_KEY_REQUIRED");
    const now = timestamp(input.now ?? new Date());
    const cutoff = new Date(now.getTime() - input.policy.maxCallSeconds * 1000);
    const window = input.policy.certificationWindow;
    // Expiry drains only inbound calls received in this explicit window.
    // It does not disable observers or imply that the remote call has closed.
    const expiredWindow = window && now.getTime() >= window.endsAtMs ? [{
      direction: "INBOUND",
      startedAt: { gte: new Date(window.startsAtMs), lt: new Date(window.endsAtMs) },
    }] : [];
    const due = await this.db.salesVoiceCall.findMany({
      where: { provider: "OPENAI_LIVE_SIP", finalizedAt: null,
        status: { in: [...RUNNING] }, hangupClaimedAt: null,
        OR: [
          { answeredAt: { lte: cutoff } },
          { answeredAt: null, startedAt: { lte: cutoff } },
          ...expiredWindow,
        ],
      },
      orderBy: { startedAt: "asc" },
      take: input.policy.batchSize,
      select: { providerCallId: true },
    });
    const output = { inspected: due.length, claimed: 0, sent: 0, unknown: 0 };
    for (const item of due) {
      if (!item.providerCallId) continue;
      const decision = await this.claimHangup(item.providerCallId, now);
      if (decision !== "CLAIMED") continue;
      output.claimed++;
      let succeeded = false;
      try {
        await postOneLiveHangup({
          sessionId: item.providerCallId, apiKey: input.apiKey,
          transport: input.transport, enabled: true,
        });
        succeeded = true;
      } catch {
        // Network ambiguity or provider error: no automatic repeat.
      }
      await this.recordHangupResult(item.providerCallId, succeeded, now);
      if (succeeded) output.sent++; else output.unknown++;
    }
    return output;
  }
}
