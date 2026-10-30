import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { assertLabEnvironment, installLabNetworkFence } from "./isolation";

assertLabEnvironment(process.env);
const role = process.env.GUEST_JOURNEY_LAB_ROLE;
if (!["api", "communications", "monitor"].includes(role ?? "")) {
  throw new Error("GJ_LAB_ROLE_INVALID");
}

if (process.argv.includes("--prepare")) {
  if (role !== "api") throw new Error("GJ_LAB_PREPARE_REQUIRES_API");
  // Only the new lab database may receive the repository's migrations.
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    stdio: "inherit", env: { ...process.env, CHECKPOINT_DISABLE: "1" },
  });
}

installLabNetworkFence();
const runtime = await import("./runtime");
// Also fail closed if any imported module attempted to load a local .env.
assertLabEnvironment(process.env);
await runtime.prisma.$connect();

if (process.argv.includes("--prepare")) {
  await runtime.prepareLabTables();
  await runtime.prisma.$disconnect();
  console.log("GJ_LAB_SCHEMA_READY");
  process.exit(0);
}

await runtime.heartbeat(role!, { status: "STARTED", simulationOnly: true });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopping = true;
    void runtime.prisma.$disconnect().finally(() => process.exit(0));
  });
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guest Journey Lab</title><style>
body{font:16px system-ui;background:#edf2f7;color:#182c40;margin:0;padding:32px}
main{max-width:1100px;margin:auto;background:white;padding:28px;border-radius:12px}
h1{margin-top:0}strong{color:#a13c18}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f9;padding:20px;font-size:13px}
</style><main><h1>Guest Journey Lab</h1><p><strong>Simulation only · Production certification pending</strong></p>
<p>Real E4/E7 code and isolated PostgreSQL. Provider responses and delivery receipts are simulated.
This evidence monitor does not certify the full reservation journey or host Mission Control.</p>
<p>Read-only view. No real guest messages, payments, locks or OTA changes.</p><pre id="evidence">Loading evidence…</pre>
<script>async function refresh(){try{const r=await fetch('/evidence');if(!r.ok)throw Error('Evidence unavailable');
document.getElementById('evidence').textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.getElementById('evidence').textContent=e.message}}
refresh();setInterval(refresh,15000)</script></main></html>`;

if (role === "api") {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    try {
      if (request.url === "/health" || request.url === "/ready") {
        await runtime.prisma.$queryRaw`SELECT 1`;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok", mode: "simulation", productionReady: false }));
      } else if (request.url === "/evidence") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(await runtime.readLabEvidence()));
      } else if (request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      } else { response.writeHead(404); response.end(); }
    } catch {
      response.writeHead(503); response.end("Lab evidence temporarily unavailable");
    }
  });
  server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => console.log("GJ_LAB_API_READY"));
} else {
  if (role === "communications") await runtime.seedLabFixtures();
  while (!stopping) {
    try {
      if (role === "communications") {
        console.log("GJ_LAB_COMMUNICATIONS_CYCLE", JSON.stringify(await runtime.runCommunicationsProbe()));
        console.log("GJ_LAB_COMMUNICATIONS_RECOVERY", JSON.stringify(await runtime.runRecoveryProbe()));
        console.log("GJ_LAB_PRECHECKIN_SHADOW", JSON.stringify(await runtime.runPrecheckinShadowProbe()));
      } else {
        const evidence = await runtime.readLabEvidence();
        await runtime.heartbeat("monitor", {
          mode: "OBSERVE_ONLY", messages: evidence.messages.length,
          waiting: evidence.intents.filter(intent => intent.status === "WAITING_FOR_EVIDENCE").length,
          receiptRecoveryEnabled: true,
          uncorrelatedOutcomeRecoveryImplemented: false,
        });
      }
    } catch (error) {
      // Error messages can contain connection strings. Persist a safe status;
      // never print configuration, raw provider payloads or stack traces.
      console.error("GJ_LAB_CYCLE_FAILED", error instanceof Error ? error.name : "UnknownError");
      await runtime.heartbeat(role!, { status: "FAILED", needsInvestigation: true }).catch(() => {});
    }
    await wait(10_000);
  }
}
