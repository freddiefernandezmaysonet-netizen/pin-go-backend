import "dotenv/config";

import {
  runDeviceHealthWorker,
} from "./deviceHealth.worker";

const HOUR_MS =
  60 * 60 * 1000;

let tickRunning = false;
let nextTimer:
  NodeJS.Timeout | null = null;

async function tick() {
  if (tickRunning) {
    console.warn(
      "DeviceHealth worker tick skipped because a previous execution is still running"
    );
    return;
  }

  tickRunning = true;

  try {
    await runDeviceHealthWorker();
  } catch (error) {
    console.error(
      "DeviceHealth worker tick failed",
      error
    );
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick() {
  nextTimer =
    setTimeout(async () => {
      try {
        await tick();
      } finally {
        scheduleNextTick();
      }
    }, HOUR_MS);
}

async function shutdown(
  signal: string
) {
  console.log(
    `DeviceHealth worker received ${signal}; shutting down`
  );

  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }

  const shutdownStartedAt =
    Date.now();

  while (
    tickRunning &&
    Date.now() -
      shutdownStartedAt <
      30_000
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, 250)
    );
  }

  process.exit(
    tickRunning
      ? 1
      : 0
  );
}

async function main() {
  console.log(
    "Starting DeviceHealth worker process"
  );

  await tick();
  scheduleNextTick();
}

process.once(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);

process.once(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

main().catch((error) => {
  console.error(
    "DeviceHealth worker boot failed",
    error
  );

  process.exit(1);
});