// Bundle into one Railway Function file. No schedule, public endpoint or model call.
import postgres from "postgres@3.4.7";
import { ensureGlobalMessageWebhook } from "../src/channex-messaging/pin-ai-global-webhook.js";
const env = process.env;
if (env.PIN_AI_GLOBAL_WEBHOOK_CONFIGURE !== "true") throw Error("PIN_AI_GLOBAL_WEBHOOK_CONFIGURE_DISABLED");
if (env.OTA_CONNECTION_PROVIDER_API_ORIGIN !== "https://app.channex.io" || !env.OTA_CONNECTION_API_KEY ||
    !env.PIN_AI_CHANNEX_WEBHOOK_SECRET || !env.DATABASE_URL) throw Error("PIN_AI_GLOBAL_WEBHOOK_CONFIGURATION_INVALID");
const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10 });
const id = "pin-ai-global-message-webhook-production-v1";
try {
  const result = await ensureGlobalMessageWebhook({
    callbackUrl: "https://api.pin-ngo.com/webhooks/ota/channex/messages", secret: env.PIN_AI_CHANNEX_WEBHOOK_SECRET,
    claim: async () => {
      const rows = await sql`INSERT INTO "MessageLog" ("id", "channel", "to", "body", "provider", "status", "communicationType", "createdAt", "retryCount")
        VALUES (${id}, 'configuration', 'https://api.pin-ngo.com/webhooks/ota/channex/messages', 'Global message webhook registration',
          'channex', 'SENDING', 'PIN_AI_GLOBAL_MESSAGE_WEBHOOK_CONFIGURATION', NOW(), 0)
        ON CONFLICT ("id") DO NOTHING RETURNING "id"`;
      return rows.length === 1;
    },
    verified: async providerId => {
      await sql`INSERT INTO "MessageLog" ("id", "channel", "to", "body", "provider", "status", "communicationType", "createdAt", "retryCount", "providerMessageId")
        VALUES (${id}, 'configuration', 'https://api.pin-ngo.com/webhooks/ota/channex/messages', 'Global message webhook verified',
          'channex', 'VERIFIED', 'PIN_AI_GLOBAL_MESSAGE_WEBHOOK_CONFIGURATION', NOW(), 0, ${providerId})
        ON CONFLICT ("id") DO UPDATE SET "status" = 'VERIFIED', "providerMessageId" = ${providerId}`;
    },
    request: async (method, page, body) => {
      const url = new URL("/api/v1/webhooks", env.OTA_CONNECTION_PROVIDER_API_ORIGIN);
      if (method === "GET") { url.searchParams.set("pagination[page]", String(page)); url.searchParams.set("pagination[limit]", "100"); }
      const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { "user-api-key": env.OTA_CONNECTION_API_KEY!, Accept: "application/json", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw Error("PIN_AI_GLOBAL_WEBHOOK_PROVIDER_REJECTED"); }
      return response.json();
    },
  });
  console.log(JSON.stringify({ certificate: "PIN_AI_GLOBAL_MESSAGE_WEBHOOK", verified: true, ...result }));
} catch (error) {
  console.error(error instanceof Error && /^PIN_AI_GLOBAL_WEBHOOK_[A-Z_]+$/.test(error.message)
    ? error.message : "PIN_AI_GLOBAL_WEBHOOK_EXECUTION_FAILED");
  process.exitCode = 1;
} finally { await sql.end(); }
