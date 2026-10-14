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
 * Isolated certification controller; no timer or default provider transport.
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
    this.input = { ...input, admissionLimits: { ...input.admissionLimits } };
    this.recovery = new SimulatedSalesVoiceRecoverySupervisor(this.input);
    this.watchdog = new SalesVoiceLiveWatchdog(this.input.db);
  }

  completion(sessionId: string) { return this.recovery.completion(sessionId); }
  snapshot() { return this.recovery.snapshot(); }
  stop(): void { this.stopped = true; this.recovery.stop(); }

  async tick(): Promise<{
    state: "READY" | "DISABLED";
    recovery?: Awaited<ReturnType<SimulatedSalesVoiceRecoverySupervisor["sweep"]>>;
    watchdog?: WatchdogResult;
  }> {
    if (this.busy) throw new Error("SAFETY_CONTROLLER_TICK_BUSY");
    if (this.stopped || !permitted(this.input.env)) {
      this.stop(); return { state: "DISABLED" };
    }
    this.busy = true;
    try {
      const recovery = await this.recovery.sweep();
      if (recovery.state === "DISABLED" || !permitted(this.input.env) || this.stopped) {
        this.stop(); return { state: "DISABLED", recovery };
      }
      const [time] = await this.input.db.$queryRaw<Array<{ now: Date }>>
        `SELECT clock_timestamp() AS "now"`;
      if (!(time?.now instanceof Date) || !Number.isFinite(time.now.getTime())) {
        throw new Error("SAFETY_DATABASE_CLOCK_REQUIRED");
      }
      if (!permitted(this.input.env) || this.stopped) {
        this.stop(); return { state: "DISABLED", recovery };
      }
      const watchdog = await this.watchdog.runOnce({
        policy: { enabled: true, maxCallSeconds: this.input.maxCallSeconds, batchSize: this.input.maxOwned },
        apiKey: this.apiKey, now: time.now,
        transport: async (url, request) => {
          if (!permitted(this.input.env) || this.stopped) throw new Error("SAFETY_TRANSPORT_DISABLED");
          return this.input.hangup(url, request);
        },
      });
      if (!permitted(this.input.env) || this.stopped) {
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
