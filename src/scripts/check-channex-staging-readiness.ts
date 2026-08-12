import "dotenv/config";
import { prisma } from "../lib/prisma";
import { getChannexStagingReadinessReport } from "../services/channex-staging-readiness.service";

async function main() {
  const report = await getChannexStagingReadinessReport();

  console.log(
    JSON.stringify(
      {
        ok: report.ready,
        provider: report.provider,
        environment: report.environment,
        generatedAt: report.generatedAt,
        propertyId: report.propertyId,
        callbackUrl: report.callbackUrl,
        connectionCount: report.connectionCount,
        listingCount: report.listingCount,
        summary: report.summary,
        checks: report.checks,
      },
      null,
      2
    )
  );

  if (!report.ready) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
