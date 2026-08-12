const WORKER_NAME = "dynamic-pricing-sync.worker";

function log(message: string) {
  console.log(`[${WORKER_NAME}] ${message}`);
}

log(
  "Retired: periodic monolithic Channex synchronization is disabled. " +
    "Use the durable channex-ari-dispatch worker and producer outbox lifecycle."
);
