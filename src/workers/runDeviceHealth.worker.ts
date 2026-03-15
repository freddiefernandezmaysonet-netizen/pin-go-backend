import "dotenv/config";
import { runDeviceHealthWorker } from "./deviceHealth.worker";

const HOUR_MS = 60 * 60 * 1000;

async function tick() {
  try {
    await runDeviceHealthWorker();
  } catch (err) {
    console.error("❌ deviceHealth worker tick failed", err);
  }
}

async function main() {
  console.log("🚀 starting deviceHealth worker process");

  await tick();

  setInterval(() => {
    tick().catch((err) => {
      console.error("❌ unhandled deviceHealth tick error", err);
    });
  }, HOUR_MS);
}

main().catch((err) => {
  console.error("❌ deviceHealth worker boot failed", err);
  process.exit(1);
});