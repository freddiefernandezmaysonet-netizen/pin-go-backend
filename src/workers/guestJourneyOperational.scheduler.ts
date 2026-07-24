import { prisma } from "../lib/prisma";
import {
  reconcileGuestJourneyOperationalIssues,
} from "../services/guest-journey-operational.service";

const DEFAULT_SYNC_INTERVAL_MS =
  5 * 60 * 1000;
const MINIMUM_SYNC_INTERVAL_MS =
  60_000;
const FAILURE_RETRY_DELAY_MS =
  60_000;

const syncIntervalMs = Math.max(
  MINIMUM_SYNC_INTERVAL_MS,
  Number(
    process.env
      .GUEST_JOURNEY_OPERATIONAL_SYNC_MS ??
      DEFAULT_SYNC_INTERVAL_MS
  ) || DEFAULT_SYNC_INTERVAL_MS
);

let started = false;
let stopped = false;
let running = false;
let nextTimer: NodeJS.Timeout | null = null;

function log(
  message: string,
  metadata?: Record<string, unknown>
) {
  console.log(
    "[guest-journey-operational]",
    message,
    metadata ?? ""
  );
}

function logError(
  message: string,
  error: unknown
) {
  console.error(
    "[guest-journey-operational]",
    message,
    error instanceof Error
      ? error.stack || error.message
      : String(error)
  );
}

function scheduleNextTick(delayMs: number) {
  if (stopped) {
    return;
  }

  nextTimer = setTimeout(() => {
    void tick();
  }, delayMs);
}

async function tick() {
  if (stopped) {
    return;
  }

  if (running) {
    scheduleNextTick(syncIntervalMs);
    return;
  }

  running = true;

  try {
    const result =
      await reconcileGuestJourneyOperationalIssues(
        prisma,
        new Date()
      );

    if (
      result.processed > 0 ||
      result.failed > 0
    ) {
      log(
        "Operational reconciliation completed",
        result
      );
    }

    scheduleNextTick(syncIntervalMs);
  } catch (error) {
    logError(
      "Operational reconciliation failed",
      error
    );
    scheduleNextTick(
      FAILURE_RETRY_DELAY_MS
    );
  } finally {
    running = false;
  }
}

export function startGuestJourneyOperationalScheduler() {
  if (started) {
    return {
      started: false as const,
      reason:
        "ALREADY_STARTED" as const,
    };
  }

  started = true;
  stopped = false;

  log("Scheduler starting", {
    syncIntervalMs,
  });

  void tick();

  return {
    started: true as const,
    stop() {
      stopped = true;

      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
    },
  };
}
