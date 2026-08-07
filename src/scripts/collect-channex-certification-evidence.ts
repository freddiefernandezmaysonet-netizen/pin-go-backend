import "dotenv/config";
import { prisma } from "../lib/prisma";
import { collectChannexCertificationEvidence } from "../services/channex-certification-evidence.service";

async function main() {
  const revisionId = String(process.env.CHANNEX_REVISION_ID ?? "").trim();

  if (!revisionId) {
    throw new Error("CHANNEX_REVISION_ID_REQUIRED");
  }

  const evidence = await collectChannexCertificationEvidence({ revisionId });

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...evidence,
      },
      null,
      2
    )
  );

  if (
    evidence.outcome === "FAIL_INCOMPLETE" ||
    evidence.outcome === "ACTION_REQUIRED"
  ) {
    process.exitCode = 1;
  } else if (evidence.outcome === "PENDING_AUTOMATIC_RECOVERY") {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          provider: "PIN_GO_CONNECT",
          error: error instanceof Error ? error.message : String(error),
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
