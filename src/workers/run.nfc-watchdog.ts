import { startNfcWatchdog } from "./nfc-watchdog.worker";

startNfcWatchdog().catch((e) => {
  console.error("[nfc.watchdog] FATAL", e?.message ?? e);
  process.exit(1);
});
