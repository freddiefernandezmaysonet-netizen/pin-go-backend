import { prisma } from "../src/lib/prisma.js";
import {
  createChannexAirbnbPostAuthProvider,
} from "../src/distribution/airbnb-post-auth-autopilot.owner.js";
import {
  recoverMissedAirbnbActivation,
} from "../src/distribution/airbnb-missed-activation.recovery.js";

const CONFIRM = "RECOVER_CASA_COLLORES_AIRBNB_MISSED_ACTIVATION";

async function main() {
  if (process.argv[2] !== `--confirm=${CONFIRM}`) {
    throw new Error("RECOVERY_CONFIRMATION_REQUIRED");
  }
  if (process.env.NODE_ENV !== "production") {
    throw new Error("RECOVERY_REQUIRES_PRODUCTION");
  }
  const apiOrigin = String(
    process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN ?? ""
  ).trim();
  const apiKey = String(process.env.OTA_CONNECTION_API_KEY ?? "").trim();
  if (apiOrigin !== "https://app.channex.io" || !apiKey) {
    throw new Error("RECOVERY_PROVIDER_CONFIGURATION_INVALID");
  }

  const provider = createChannexAirbnbPostAuthProvider({
    apiOrigin,
    apiKey,
  });

  const result = await recoverMissedAirbnbActivation({
    prisma,
    provider,
    target: {
      organizationId: "cmo1syqey0001p01dlopyf5w5",
      propertyId: "cmo1t0gwq000bp01d0wrujlh2",
      connectionId: "cmttiomxe0005p51553hxn62i",
      channelId: "04ef2057-cca7-4e28-be54-f991f461a1cd",
      externalPropertyId: "b58de550-63f8-49dc-abfa-4629b94a2160",
      externalGroupId: "a05d501f-7d1a-40fd-a21e-2805d818e527",
      ratePlanId: "bfd7dfe7-0c6d-4145-bbc4-45546780d720",
      listingId: "551126434553599406",
    },
  });

  const output = result.recovered
    ? {
        recovered: true,
        reason: null,
        observedAt: result.observedAt.toISOString(),
        decisionId: result.decisionId,
      }
    : {
        recovered: false,
        reason: result.reason,
        observedAt: null,
        decisionId: null,
      };

  console.log(
    `AIRBNB_MISSED_ACTIVATION_RECOVERY=${JSON.stringify(output)}`
  );
}

main()
  .catch((error) => {
    console.error(
      `AIRBNB_MISSED_ACTIVATION_RECOVERY_FAILED=${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
