import "dotenv/config";

// Separate worker process; never imported by the API. Disabled until an
// authorized worker deployment explicitly opts in after the migration.
if (process.env.STAY_TIME_RECOVERY_ENABLED !== "true") {
  console.log("[STAY_TIME_RECOVERY] disabled");
} else {
  const { prisma } = await import("../lib/prisma.js");
  const { default: stripe } = await import("../billing/stripe.js");
  const { reconcileReservation } = await import("../services/reservation.reconcile.service.js");
  const { createStayTimeStripeProvider } = await import("../services/stay-time-stripe-provider.js");
  const { runStayTimeRecoveryBatch } = await import("../services/stay-time-recovery.service.js");
  const now = () => new Date();
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      try {
        const result = await runStayTimeRecoveryBatch({ client: prisma, now, reconcile: reconcileReservation,
          ...createStayTimeStripeProvider(stripe, now) });
        if (result.processed) console.log("[STAY_TIME_RECOVERY]", {
          processed: result.processed, outcomes: result.results.map(r => r.outcome),
        });
      } catch {
        console.error("[STAY_TIME_RECOVERY] batch failed; persisted work retained");
      }
      if (!stopped) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 60_000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await prisma.$disconnect();
  }
}
