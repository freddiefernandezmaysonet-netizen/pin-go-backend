import { startPmsWatchdog } from "./pms-watchdog.worker";

startPmsWatchdog().catch((e) => {
  console.error("[pms.watchdog] FATAL", e?.message ?? e);
  process.exit(1);
});