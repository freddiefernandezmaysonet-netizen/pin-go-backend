import { performance } from "node:perf_hooks";
import type { ObserverHeartbeatTimer } from "./sales-voice-live-session-coordinator.service.js";
import type { PrismaClient } from "@prisma/client";
import type { AdmissionLimits } from "./sales-voice-live-admission.service.js";
import { SalesVoiceLiveWatchdog, type HangupHTTP } from "./sales-voice-live-watchdog.service.js";
import { SimulatedSalesVoiceRecoverySupervisor } from "./sales-voice-recovery-supervisor.service.js";
import type { SidebandSocketFactory } from "./sales-voice-sideband-supervisor.service.js";

type DB = Pick<PrismaClient, "salesVoiceCall" | "$queryRaw" | "$transaction">;
type Env = Readonly<Record<string, string | undefined>>;
const permitted = (env: Env): boolean =>
  env.NODE_ENV === "test"
  && env.RAILWAY_ENVIRONMENT_NAME === "sales-voice-certification"
  && env.SALES_VOICE_SAFETY_CONTROLLER_SIMULATION_ENABLED === "true"
  && env.SALES_VOICE_SAFETY_CONTROLLER_RELEASE_CERTIFIED === "true";
type WatchdogResult = { inspected: number; claimed: number; sent: number; unknown: number };

/**
 * Isolated certification controller; no automatic timer or default provider transport.
 * Recovery leases govern observers. The independent duration guardian uses
 * the existing persisted hangup claim, shared across ALL controller processes.
 * No HTTP acknowledgment, timeout or disconnect releases capacity here.
 * Reservation alignment is an ESTIMATE, never a certified hard monetary cap.
 */
export class SimulatedSalesVoiceSafetyController {
  private readonly recovery: SimulatedSalesVoiceRecoverySupervisor;
  private readonly watchdog: SalesVoiceLiveWatchdog;
  private readonly apiKey: string;
  private busy = false;
  private stopped = false;
  private loopStarted = false;
  private cancelLoop?: () => void;
  private loopGate?: () => boolean;
  private admissionReady?: () => boolean;
  private active(): boolean { return !this.stopped && permitted(this.input.env) && (!this.loopGate || this.loopGate()); }

  constructor(private readonly input: {
    db: DB; env: Env; owner: string; ttlSeconds: number; staleAfterSeconds: number;
    maxOwned: number; maxCallSeconds: number; maxSweepIntervalSeconds: number;
    admissionLimits: AdmissionLimits;
    connect: SidebandSocketFactory; hangup: HangupHTTP;
  }) {
    if (!permitted(input.env)) throw new Error("SAFETY_CONTROLLER_PRODUCTION_VETO");
    const limits = input.admissionLimits;
    const reserveCents = Math.ceil(limits.reservedSecondsPerCall / 60) * limits.estimatedCentsPerMinute;
    // The guardian sends sequentially: reserve the existing five-second
    // request timeout for every candidate in the bounded batch.
    if (!limits.enabled
      || !Number.isSafeInteger(limits.maxConcurrentCalls) || limits.maxConcurrentCalls < 1 || limits.maxConcurrentCalls > 10
      || !Number.isSafeInteger(limits.monthlyBudgetCents) || limits.monthlyBudgetCents < 1
      || !Number.isSafeInteger(limits.estimatedCentsPerMinute) || limits.estimatedCentsPerMinute < 1
      || !Number.isSafeInteger(limits.reservedSecondsPerCall) || limits.reservedSecondsPerCall < 60 || limits.reservedSecondsPerCall > 3600
      || !Number.isSafeInteger(input.maxCallSeconds) || input.maxCallSeconds < 60 || input.maxCallSeconds > 3600
      || !Number.isSafeInteger(input.maxSweepIntervalSeconds) || input.maxSweepIntervalSeconds < 1 || input.maxSweepIntervalSeconds > 60
      || limits.reservedSecondsPerCall < input.maxCallSeconds + input.maxSweepIntervalSeconds + 5 * input.maxOwned
      || !Number.isSafeInteger(reserveCents) || reserveCents > limits.monthlyBudgetCents
      || input.maxOwned > limits.maxConcurrentCalls
      || typeof input.hangup !== "function") throw new Error("SAFETY_RESERVATION_LIMITS_MISMATCH");
    const key = input.env.SALES_VOICE_OPENAI_API_KEY;
    if (!key?.startsWith("sk-")) throw new Error("COMMERCIAL_SAFETY_KEY_REQUIRED");
    this.apiKey = key;
    // Snapshot validated scalars/transport; only the referenced release gates remain dynamic.
    this.input = { ...input, admissionLimits: { ...input.admissionLimits,
      certificationWindow: input.admissionLimits.certificationWindow?{...input.admissionLimits.certificationWindow}:undefined } };
    this.recovery = new SimulatedSalesVoiceRecoverySupervisor({ ...this.input, connect: (url, options) => {
      if (!this.active()) throw new Error("SAFETY_TRANSPORT_DISABLED");
      return this.input.connect(url, options);
    } });
    this.watchdog = new SalesVoiceLiveWatchdog(this.input.db);
  }

  /** Local supervision proof only: no remote call-state inference. */
  permitsAdmission(limits: AdmissionLimits): boolean {
    try {
      if (!this.active() || this.admissionReady?.() !== true) return false;
      const required = this.input.admissionLimits;
      return limits.enabled === required.enabled
        && limits.maxConcurrentCalls === required.maxConcurrentCalls
        && limits.monthlyBudgetCents === required.monthlyBudgetCents
        && limits.estimatedCentsPerMinute === required.estimatedCentsPerMinute
        && limits.reservedSecondsPerCall === required.reservedSecondsPerCall
        && limits.certificationWindow?.startsAtMs === required.certificationWindow?.startsAtMs
        && limits.certificationWindow?.endsAtMs === required.certificationWindow?.endsAtMs;
    } catch { return false; }
  }

  completion(sessionId: string) { return this.recovery.completion(sessionId); }
  snapshot() { return this.recovery.snapshot(); }
  stop(): void {
    this.stopped = true;
    const cancel = this.cancelLoop; this.cancelLoop = undefined;
    cancel?.(); this.recovery.stop();
  }

  /** Explicit certification scheduling; construction/import starts no timers. */
  startLoop(options: {
    pollMs: number; schedule?: ObserverHeartbeatTimer; monotonicNow?: () => number;
  }): {stop: () => void; snapshot: () => {phase: string; cycles: number}} {
    const enabled = () => permitted(this.input.env)
      && this.input.env.SALES_VOICE_SAFETY_LOOP_SIMULATION_ENABLED === "true"
      && this.input.env.SALES_VOICE_SAFETY_LOOP_RELEASE_CERTIFIED === "true";
    if (!enabled()) throw new Error("SAFETY_LOOP_PRODUCTION_AND_RELEASE_VETO");
    if (this.loopStarted || this.stopped || this.busy) throw new Error("SAFETY_LOOP_ALREADY_STARTED_OR_STOPPED");
    const intervalMs = this.input.maxSweepIntervalSeconds * 1000, pollMs = options.pollMs;
    if (!Number.isSafeInteger(pollMs) || pollMs < 1000
      || pollMs > Math.floor(intervalMs / 2) || this.input.ttlSeconds < 30
      || intervalMs > Math.floor(this.input.ttlSeconds * 1000 / 3)) {
      throw new Error("INVALID_SAFETY_LOOP_BOUNDS");
    }
    this.loopStarted = true; this.loopGate = enabled;
    const now = options.monotonicNow ?? (() => performance.now());
    const schedule: ObserverHeartbeatTimer = options.schedule ?? ((task, delayMs) => {
      const timer = setTimeout(() => { void task(); }, delayMs);
      timer.unref(); return () => clearTimeout(timer);
    });
    let phase = "RUNNING", cycles = 0, generation = 0, inFlight = false;
    let cancelWake: (() => void) | undefined, cancelDeadline: (() => void) | undefined;
    let lastStart: number;
    const clock = () => {
      const value = now();
      if (!Number.isFinite(value) || value < 0) throw new Error("SAFETY_MONOTONIC_CLOCK_REQUIRED");
      return value;
    };
    this.admissionReady = () => {
      const time = clock();
      return phase === "RUNNING" && cycles > 0 && !inFlight && !this.busy
        && enabled()
        && this.input.env.SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED === "true"
        && this.input.env.SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED === "true"
        && this.input.env.SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED === "true"
        && this.input.env.SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED === "true"
        && time >= lastStart && time - lastStart < intervalMs;
    };
    const cancelTimers = () => {
      generation++;
      const wake = cancelWake, deadline = cancelDeadline;
      cancelWake = cancelDeadline = undefined;
      try { wake?.(); } catch { /* generation still fences callback */ }
      try { deadline?.(); } catch { /* generation still fences callback */ }
    };
    this.cancelLoop = () => {
      if (phase === "RUNNING") phase = "STOPPED";
      cancelTimers();
    };
    const halt = (reason: string) => {
      if (phase !== "RUNNING") return;
      phase = reason; this.stop(); // local observers only; capacity stays persisted
    };
    const arm = (delayMs: number) => {
      if (phase !== "RUNNING") return;
      const token = ++generation;
      cancelWake = schedule(async () => {
        if (phase !== "RUNNING" || token !== generation || inFlight) return;
        cancelWake = undefined; inFlight = true;
        try {
          if (!enabled()) { halt("STOPPED"); return; }
          const start = clock();
          if (start < lastStart) { halt("FAILED"); return; }
          if (start - lastStart >= intervalMs) { halt("DELAYED"); return; }
          lastStart = start;
          // Deadline halts a pending cycle, never overlaps ticks or replays requests.
          cancelDeadline = schedule(async () => {
            if (phase === "RUNNING" && token === generation) halt("DELAYED");
          }, intervalMs);
          if (typeof cancelDeadline !== "function") throw new Error("INVALID_SAFETY_DEADLINE_TIMER");
          const result = await this.tick();
          if (phase !== "RUNNING" || token !== generation) return;
          cancelDeadline(); cancelDeadline = undefined;
          if (!enabled() || result.state !== "READY") { halt("STOPPED"); return; }
          const end = clock();
          if (end < start) { halt("FAILED"); return; }
          if (end - start >= intervalMs) { halt("DELAYED"); return; }
          cycles++;
          arm(Math.max(0, pollMs - (end - start)));
        } catch { halt("FAILED"); }
        finally { inFlight = false; }
      }, delayMs);
      if (typeof cancelWake !== "function") throw new Error("INVALID_SAFETY_WAKE_TIMER");
    };
    try { lastStart = clock(); arm(0); }
    catch { halt("FAILED"); }
    return {stop: () => this.stop(), snapshot: () => ({phase, cycles})};
  }

  async tick(): Promise<{
    state: "READY" | "DISABLED";
    recovery?: Awaited<ReturnType<SimulatedSalesVoiceRecoverySupervisor["sweep"]>>;
    watchdog?: WatchdogResult;
  }> {
    if (this.busy) throw new Error("SAFETY_CONTROLLER_TICK_BUSY");
    if (!this.active()) {
      this.stop(); return { state: "DISABLED" };
    }
    this.busy = true;
    try {
      const recovery = await this.recovery.sweep();
      if (recovery.state === "DISABLED" || !this.active()) {
        this.stop(); return { state: "DISABLED", recovery };
      }
      const [time] = await this.input.db.$queryRaw<Array<{ now: Date }>>
        `SELECT clock_timestamp() AS "now"`;
      if (!(time?.now instanceof Date) || !Number.isFinite(time.now.getTime())) {
        throw new Error("SAFETY_DATABASE_CLOCK_REQUIRED");
      }
      if (!this.active()) {
        this.stop(); return { state: "DISABLED", recovery };
      }
      const watchdog = await this.watchdog.runOnce({
        policy: { enabled: true, maxCallSeconds: this.input.maxCallSeconds, batchSize: this.input.maxOwned },
        apiKey: this.apiKey, now: time.now,
        transport: async (url, request) => {
          if (!this.active()) throw new Error("SAFETY_TRANSPORT_DISABLED");
          return this.input.hangup(url, request);
        },
      });
      if (!this.active()) {
        this.stop(); return { state: "DISABLED", recovery, watchdog };
      }
      return { state: "READY", recovery, watchdog };
    } catch {
      this.stop(); throw new Error("SAFETY_CONTROLLER_FAILED_CLOSED");
    } finally {
      this.busy = false;
    }
  }
}
