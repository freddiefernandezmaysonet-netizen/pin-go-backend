import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

export const LAB_PROJECT_ID = "10619a4a-d72c-4997-b08d-4bad1b0fe60b";
export const LAB_ENVIRONMENT_ID = "437014cf-52bf-4c3c-a92a-e1738d01d712";
export const LAB_DATABASE = "guest_journey_lab";

/** This entry point is deliberately unavailable in the production project. */
export function assertLabEnvironment(env: NodeJS.ProcessEnv): URL {
  if (env.RAILWAY_PROJECT_ID !== LAB_PROJECT_ID ||
      env.RAILWAY_ENVIRONMENT_ID !== LAB_ENVIRONMENT_ID ||
      env.RAILWAY_ENVIRONMENT_NAME !== "guest-journey-test" ||
      env.GUEST_JOURNEY_LAB_MODE !== "simulation" || env.NODE_ENV !== "test") {
    throw new Error("GJ_LAB_ISOLATION_SCOPE_REJECTED");
  }
  const forbidden = Object.keys(env).filter(key => env[key]?.trim() && (
    /^(TWILIO_|RESEND_|STRIPE_|CHANNEX_|TTLOCK_|OPENAI_|EXPO_ACCESS_TOKEN$)/.test(key) ||
    /^(ACCESS_CODE_ENC_KEY_BASE64|NFC_.*SECRET|GUEST_TOKEN_SECRET)$/.test(key)
  ));
  if (forbidden.length) throw new Error(`GJ_LAB_PROVIDER_CONFIGURATION_REJECTED:${forbidden.sort().join(",")}`);
  if (env.OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS !== "AIRBNB,BOOKING_COM") {
    throw new Error("GJ_LAB_CHANNEL_POLICY_REQUIRED");
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GUEST_JOURNEY_") && (key.endsWith("_EXECUTE") || key.endsWith("_ENABLED")) &&
        !["", "0", "false", "off"].includes(String(env[key] ?? "").trim().toLowerCase())) {
      throw new Error(`GJ_LAB_PRODUCTION_CYCLE_FLAG_REJECTED:${key}`);
    }
  }
  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ""); }
  catch { throw new Error("GJ_LAB_DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) ||
      database.hostname !== "postgres.railway.internal" ||
      (database.port && database.port !== "5432") ||
      database.pathname !== `/${LAB_DATABASE}` ||
      database.username !== "guest_journey_lab" || !database.password ||
      database.search || database.hash) {
    throw new Error("GJ_LAB_DATABASE_TARGET_REJECTED");
  }
  return database;
}

/** Install before dynamically importing any production sender or worker code.
 * Prisma's native engine uses only the independently validated DATABASE_URL.
 * There are no external credentials, endpoints, production workers or public
 * mutation routes in this process. This is a process fence, not a cloud firewall.
 */
export function installLabNetworkFence(): void {
  const denied = (): never => { throw new Error("GJ_LAB_EXTERNAL_NETWORK_BLOCKED"); };
  globalThis.fetch = async () => denied();
  http.request = denied as typeof http.request;
  http.get = denied as typeof http.get;
  https.request = denied as typeof https.request;
  https.get = denied as typeof https.get;
  net.connect = denied as typeof net.connect;
  net.createConnection = denied as typeof net.createConnection;
  net.Socket.prototype.connect = denied as typeof net.Socket.prototype.connect;
  tls.connect = denied as typeof tls.connect;
  syncBuiltinESMExports();
}
