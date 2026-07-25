import "dotenv/config";
import { prisma } from "../lib/prisma";
import { configureChannexBookingWebhookForStaging } from "../services/channex-booking-webhook-registration.service";

const REQUIRED_CONFIRMATION = "CONFIGURE_CHANNEX_STAGING_WEBHOOK";

function requiredEnv(name: string) {
  const value = String(process.env[name] ?? "").trim();

  if (!value) {
    throw new Error(`${name}_REQUIRED`);
  }

  return value;
}

async function main() {
  const confirmation = requiredEnv(
    "CHANNEX_STAGING_WEBHOOK_CONFIRMATION"
  );

  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error(
      "CHANNEX_STAGING_WEBHOOK_CONFIRMATION_INVALID"
    );
  }

  const result = await configureChannexBookingWebhookForStaging({
    propertyId: requiredEnv("PIN_GO_PROPERTY_ID"),
    callbackUrl: requiredEnv("CHANNEX_WEBHOOK_CALLBACK_URL"),
    apiKey: requiredEnv("CHANNEX_API_KEY"),
    apiBaseUrl:
      String(
        process.env.CHANNEX_API_BASE_URL ??
          "https://staging.channex.io"
      ).trim(),
  });

  console.log(
    "[channex.staging.booking-webhook] configured",
    result
  );
}

main()
  .catch((error) => {
    console.error(
      "[channex.staging.booking-webhook] failed",
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
