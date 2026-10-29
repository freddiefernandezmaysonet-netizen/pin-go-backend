import { PrismaClient } from "@prisma/client";
import { provisionAppReviewAccount } from "../services/provision-app-review-account.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Only --apply is supported; omit it for a read-only plan.");
const db = new PrismaClient();
try {
  const result = await provisionAppReviewAccount(db, {
    actorUserId: process.env.PINGO_APP_REVIEW_OPERATOR_USER_ID ?? "",
    apply: args.includes("--apply"),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not dump Prisma errors, connection strings or input payloads.
  const code = error instanceof Error && /^APP_REVIEW_[A-Z_]+$/.test(error.message)
    ? error.message : "APP_REVIEW_PROVISIONING_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
