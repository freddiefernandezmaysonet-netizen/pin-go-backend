import "dotenv/config";
import { prisma } from "../lib/prisma";
import { retryPendingNfcSync } from "../services/nfc-sync.service";

const POLL_MS = Number(process.env.NFC_WATCHDOG_POLL_MS ?? 30_000);
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    // Canonical selection excludes ended records and non-due retries. Its
    // compare-and-set claim also arbitrates with the reservation worker.
    const result = await retryPendingNfcSync(prisma, new Date());
    console.log("[nfc.watchdog] tick", result);
  } catch (error) {
    console.error("[nfc.watchdog] tick failed", error instanceof Error ? error.message : String(error));
  } finally {
    tickRunning = false;
  }
}

export async function startNfcWatchdog() {
  console.log(`[nfc.watchdog] BOOT poll=${POLL_MS}ms canonical recovery`);
  await tick();
  setInterval(() => void tick(), POLL_MS);
}
