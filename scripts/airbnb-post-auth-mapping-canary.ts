import { prisma } from "../src/lib/prisma.js";
import {
  createChannexAirbnbPostAuthProvider,
} from "../src/distribution/airbnb-post-auth-autopilot.owner.js";
import {
  assertAirbnbMappingCanaryEnvironment,
  createCanaryScopedPrismaOwnerStore,
  parseAirbnbMappingCanaryArgs,
  runAirbnbPostAuthMappingCanary,
} from "../src/distribution/airbnb-post-auth-canary.runner.js";

async function main() {
  const target = parseAirbnbMappingCanaryArgs(process.argv.slice(2));
  const providerOrigin = String(
    process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN ?? ""
  ).trim();
  const apiKey = String(process.env.OTA_CONNECTION_API_KEY ?? "").trim();

  assertAirbnbMappingCanaryEnvironment(process.env, providerOrigin);
  if (!apiKey) {
    throw new Error("CANARY_PROVIDER_API_KEY_MISSING");
  }

  const provider = createChannexAirbnbPostAuthProvider({
    apiOrigin: providerOrigin,
    apiKey,
  });
  const store = createCanaryScopedPrismaOwnerStore(prisma, target);

  const result = await runAirbnbPostAuthMappingCanary({
    target,
    store,
    provider,
  });

  console.log(
    `AIRBNB_MAPPING_CANARY=${JSON.stringify({
      outcome: result.outcome,
      channelId: result.channelId,
      ratePlanId: result.ratePlanId,
      listingId: result.listingId,
      providerMutations: result.providerMutations,
    })}`
  );
}

main()
  .catch((error) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "CANARY_FAILED")
        : error instanceof Error
          ? error.message
          : "CANARY_FAILED";
    console.error(`AIRBNB_MAPPING_CANARY_FAILED=${code}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
