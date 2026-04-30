import "dotenv/config";
import { runDemoFollowupWorker } from "./demo-followup.worker";

// ⏱️ cada cuánto correr (default: 30 minutos)
const INTERVAL_MS =
  Number(process.env.DEMO_FOLLOWUP_WORKER_INTERVAL_MINUTES ?? 30) *
  60 *
  1000;

async function tick() {
  try {
    await runDemoFollowupWorker();
  } catch (err) {
    console.error("[demo-followup] worker tick failed", err);
  }
}

async function main() {
  console.log("🚀 starting demo-followup worker process");

  await tick();

  setInterval(() => {
    tick().catch((err) => {
      console.error("[demo-followup] unhandled tick error", err);
    });
  }, INTERVAL_MS);
}

main().catch((err) => {
  console.error("[demo-followup] worker boot failed", err);
  process.exit(1);
});