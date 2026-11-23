import { PrismaClient } from "@prisma/client";
import { recoverDeliveryReceipts } from "../services/message-delivery-receipt-recovery.service";

async function main() {
  const mode = process.env.MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE;
  if (!mode || mode === "OFF") return;
  if (mode !== "APPLY") throw Error("DELIVERY_RECEIPT_RECOVERY_MODE_INVALID");
  const db = new PrismaClient();
  let stopping = false;
  const stop = () => {stopping = true;};
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      try {
        const result = await recoverDeliveryReceipts(db);
        console.info("DELIVERY_RECEIPT_RECOVERY_BATCH", result);
      } catch {
        // No receipt payload, addresses, credentials or provider errors in logs.
        console.error("DELIVERY_RECEIPT_RECOVERY_BATCH_FAILED");
      }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } finally {
    await db.$disconnect();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
void main().catch(() => {console.error("DELIVERY_RECEIPT_RECOVERY_START_FAILED"); process.exitCode = 1;});
