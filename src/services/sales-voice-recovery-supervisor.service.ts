import type { PrismaClient } from "@prisma/client";
import { runSimulatedSalesVoiceRecoveryCycle } from "./sales-voice-recovery-cycle.service.js";
import { observeExistingLiveSession, type SidebandSocketFactory, type SidebandSessionResult } from "./sales-voice-sideband-supervisor.service.js";
import type { RecoveryLease } from "./sales-voice-recovery-lease.service.js";

type DB = Pick<PrismaClient, "salesVoiceCall" | "$queryRaw" | "$transaction">;
type Env = Readonly<Record<string, string | undefined>>;
type Phase = "WATCHING" | "REVIEW" | "DISCONNECTED" | "CLOSED";
type RecordState = {
  lease: RecoveryLease;
  phase: Phase;
  disconnect?: () => void;
  completion?: Promise<SidebandSessionResult>;
};
const permitted = (env: Env): boolean =>
  env.NODE_ENV === "test"
  && env.RAILWAY_ENVIRONMENT_NAME === "sales-voice-certification"
  && env.SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED === "true"
  && env.SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED === "true"
  && env.SALES_VOICE_RECOVERY_SUPERVISOR_SIMULATION_ENABLED === "true"
  && env.SALES_VOICE_RECOVERY_SUPERVISOR_RELEASE_CERTIFIED === "true";

/**
 * Certification-only orchestrator: inventory -> renew/claim -> fenced observer.
 * No timer or real network client, and not imported by any API/worker.
 * Each epoch gets at most ONE attach attempt in this process. Disconnects
 * retain capacity and are NOT retried blindly. Restart/provider reconciliation
 * and global attempt/cost budgets remain separate live-release gates.
 */
export class SimulatedSalesVoiceRecoverySupervisor {
  private readonly records = new Map<string, RecordState>();
  private busy = false;
  private stopped = false;
  private readonly apiKey: string;

  constructor(private readonly input: {
    db: DB;
    env: Env;
    owner: string;
    ttlSeconds: number;
    staleAfterSeconds: number;
    maxOwned: number;
    connect: SidebandSocketFactory;
  }) {
    if (!permitted(input.env)) throw new Error("RECOVERY_SUPERVISOR_PRODUCTION_VETO");
    const key = input.env.SALES_VOICE_OPENAI_API_KEY;
    if (!key?.startsWith("sk-")) throw new Error("COMMERCIAL_RECOVERY_KEY_REQUIRED");
    if (!/^voice_[A-Za-z0-9_-]{12,70}$/.test(input.owner)
      || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 10 || input.ttlSeconds > 120
      || !Number.isSafeInteger(input.staleAfterSeconds) || input.staleAfterSeconds < 60 || input.staleAfterSeconds > 86400
      || !Number.isSafeInteger(input.maxOwned) || input.maxOwned < 1 || input.maxOwned > 25
      || typeof input.connect !== "function") throw new Error("INVALID_RECOVERY_SUPERVISOR_BOUNDS");
    this.apiKey = key; // Never read guest Pin AI OPENAI_API_KEY.
  }

  completion(sessionId: string): Promise<SidebandSessionResult> | undefined {
    return this.records.get(sessionId)?.completion;
  }

  snapshot(): ReadonlyArray<{ sessionId: string; epoch: number; phase: Phase }> {
    return [...this.records].map(([sessionId, record]) => ({
      sessionId, epoch: record.lease.epoch, phase: record.phase,
    }));
  }

  stop(): void {
    this.stopped = true;
    for (const record of this.records.values()) record.disconnect?.();
    this.records.clear(); // Leases/capacity remain persisted, never released here.
  }

  async sweep(): Promise<{
    state: "READY" | "DISABLED"; opened: number; lost: string[]; hasMore: boolean;
  }> {
    if (this.busy) throw new Error("RECOVERY_SUPERVISOR_CYCLE_BUSY");
    if (this.stopped || !permitted(this.input.env)) {
      this.stop();
      return { state: "DISABLED", opened: 0, lost: [], hasMore: false };
    }
    this.busy = true;
    let opened = 0;
    try {
      const [time] = await this.input.db.$queryRaw<Array<{ now: Date }>>
        `SELECT clock_timestamp() AS "now"`;
      if (!(time?.now instanceof Date) || !Number.isFinite(time.now.getTime())) {
        throw new Error("RECOVERY_SUPERVISOR_DATABASE_CLOCK_REQUIRED");
      }
      const cycle = await runSimulatedSalesVoiceRecoveryCycle({
        db: this.input.db, env: this.input.env, owner: this.input.owner, now: time.now,
        ttlSeconds: this.input.ttlSeconds, staleAfterSeconds: this.input.staleAfterSeconds,
        maxOwned: this.input.maxOwned,
        held: [...this.records.values()].map(record => record.lease),
      });
      for (const sessionId of cycle.lost) {
        this.records.get(sessionId)?.disconnect?.();
        this.records.delete(sessionId);
      }
      for (const owned of cycle.owned) {
        if (!permitted(this.input.env) || this.stopped) {
          this.stop();
          return { state: "DISABLED", opened, lost: cycle.lost, hasMore: cycle.hasMore };
        }
        const sessionId = owned.lease.sessionId;
        const existing = this.records.get(sessionId);
        if (existing) {
          existing.lease = owned.lease;
          // REVIEW has not attempted attach: authoritative ACCEPTED may now permit it.
          if (existing.phase !== "REVIEW" || owned.decision !== "KEEP_CAPACITY_HELD") continue;
          // Every other phase already reserved its single attempt for this epoch.
        }
        const record: RecordState = existing ?? { lease: owned.lease, phase: "REVIEW" };
        this.records.set(sessionId, record);
        if (owned.decision !== "KEEP_CAPACITY_HELD") continue;
        record.phase = "DISCONNECTED"; // Attempt is reserved before awaiting attach.
        try {
          const observer = await observeExistingLiveSession({
            db: this.input.db, sessionId, apiKey: this.apiKey, enabled: true,
            recoveryLease: owned.lease, connect: this.input.connect,
          });
          record.phase = "WATCHING";
          record.disconnect = observer.disconnect;
          record.completion = observer.completion.then(result => {
            // An old completion must not modify a replacement owner's record.
            if (this.records.get(sessionId) === record) {
              record.phase = result.state === "CONFIRMED_CLOSED" ? "CLOSED" : "DISCONNECTED";
            }
            return result; // Never issue accept/hangup from a completion callback.
          });
          opened++;
          // Gate may have been disabled during async ownership/attach validation.
          if (!permitted(this.input.env) || this.stopped) {
            this.stop();
            return { state: "DISABLED", opened, lost: cycle.lost, hasMore: cycle.hasMore };
          }
        } catch {
          // Unconfirmed attach outcome: retain claim and never replay here.
          record.phase = "DISCONNECTED";
        }
      }
      return { state: "READY", opened, lost: cycle.lost, hasMore: cycle.hasMore };
    } catch {
      this.stop(); // DB/clock failure stops all local observers without releasing capacity.
      throw new Error("RECOVERY_SUPERVISOR_FAILED_CLOSED");
    } finally {
      this.busy = false;
    }
  }
}
