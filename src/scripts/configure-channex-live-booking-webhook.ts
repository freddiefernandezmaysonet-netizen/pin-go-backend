import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma";
import { configureChannexBookingWebhookForLive } from "../services/channex-booking-webhook-registration.service";

// Preserve import compatibility while keeping one certified implementation.
export {
  configureChannexBookingWebhookForLive,
  normalizeChannexLiveBaseUrl,
  normalizeChannexLiveWebhookCallbackUrl,
} from "../services/channex-booking-webhook-registration.service";

const REQUIRED_CONFIRMATION = "CONFIGURE_CHANNEX_LIVE_WEBHOOK";
type CommandEnvironment = Readonly<Record<string, string | undefined>>;

function requiredEnv(env: CommandEnvironment, name: string) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export async function runChannexLiveBookingWebhookCommand(args: {
  env?: CommandEnvironment;
  configure?: typeof configureChannexBookingWebhookForLive;
} = {}) {
  const env = args.env ?? process.env;
  const confirmation = requiredEnv(env, "CHANNEX_LIVE_WEBHOOK_CONFIRMATION");
  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error("CHANNEX_LIVE_WEBHOOK_CONFIRMATION_INVALID");
  }
  return (args.configure ?? configureChannexBookingWebhookForLive)({
    propertyId: requiredEnv(env, "PIN_GO_PROPERTY_ID"),
    env,
  });
}

function direct() {
  try {
    return Boolean(process.argv[1]) &&
      pathToFileURL(process.argv[1]!).href === import.meta.url;
  } catch {
    return false;
  }
}

if (direct()) {
  runChannexLiveBookingWebhookCommand()
    .then((result) => {
      console.log("[channex.live.booking-webhook] configured", result);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      console.error("[channex.live.booking-webhook] failed", {
        error: /^(?:CHANNEX|PIN_GO|OTA)_[A-Z0-9_]{1,120}$/.test(message)
          ? message
          : "CHANNEX_LIVE_WEBHOOK_REGISTRATION_FAILED",
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
