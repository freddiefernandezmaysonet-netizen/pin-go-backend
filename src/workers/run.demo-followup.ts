import { runDemoFollowupWorker } from "./demo-followup.worker";

async function main() {
  console.log("[demo-followup.runner] starting");

  const result = await runDemoFollowupWorker();

  console.log("[demo-followup.runner] finished", result);
}

main().catch((error) => {
  console.error("[demo-followup.runner] failed", error);
  process.exit(1);
});