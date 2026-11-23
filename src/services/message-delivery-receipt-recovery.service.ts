import { Prisma, type PrismaClient, type MessageDeliveryReceipt } from "@prisma/client";
import { resolveCapturedReceiptMessage } from "./message-delivery-account-binding.service";
import { recordMessageDeliveryOutcome, type ProviderDeliveryOutcome } from "./guest-journey-communications-delivery-outcome.service";

const statuses = new Set(["ACCEPTED", "QUEUED", "SENDING", "SENT", "DELIVERY_DELAYED",
  "DELIVERED", "READ", "UNDELIVERED", "FAILED", "BOUNCED", "SUPPRESSED", "COMPLAINED", "CANCELED"]);

// No dispatch dependency: this job only recovers already authenticated evidence.
export async function recoverDeliveryReceipts(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const mode = env.MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE;
  if (!mode || mode === "OFF") return {examined: 0, processed: 0, providerCalls: 0 as const};
  if (mode !== "APPLY") throw Error("DELIVERY_RECEIPT_RECOVERY_MODE_INVALID");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const rows = await tx.$queryRaw<MessageDeliveryReceipt[]> `
          SELECT * FROM "MessageDeliveryReceipt"
          WHERE "processedAt" IS NULL
            AND ("lastAttemptAt" IS NULL OR "lastAttemptAt" < NOW() - INTERVAL '30 seconds')
          ORDER BY "lastAttemptAt" NULLS FIRST, "receivedAt", id
          LIMIT 50 FOR UPDATE SKIP LOCKED`;
        let processed = 0;
        for (const receipt of rows) {
          await tx.messageDeliveryReceipt.update({where: {id: receipt.id},
            data: {attempts: {increment: 1}, lastAttemptAt: new Date()}});
          if (!["resend", "twilio"].includes(receipt.provider) || !statuses.has(receipt.deliveryStatus)) {
            await tx.messageDeliveryReceipt.update({where: {id: receipt.id}, data: {lastOutcome: "INVALID_EVIDENCE"}});
            continue;
          }
          const match = await resolveCapturedReceiptMessage(tx, receipt);
          if (match.state !== "MATCHED") {
            await tx.messageDeliveryReceipt.update({where: {id: receipt.id}, data: {lastOutcome: match.state}});
            continue;
          }
          const result = await recordMessageDeliveryOutcome(tx as unknown as PrismaClient, {
            provider: receipt.provider as ProviderDeliveryOutcome["provider"],
            providerMessageId: receipt.providerMessageId,
            status: receipt.deliveryStatus as ProviderDeliveryOutcome["status"],
            eventAt: receipt.eventAt, deliveredAt: receipt.deliveredAt, errorCode: receipt.providerErrorCode,
          }, {messageLogId: match.messageLogId, accountKey: receipt.accountKey,
            organizationId: match.organizationId, propertyId: match.propertyId});
          if (!result.matched || result.messageLogId !== match.messageLogId) throw Error("DELIVERY_RECOVERY_SCOPE_CHANGED");
          await tx.messageDeliveryReceipt.update({where: {id: receipt.id}, data: {
            processedAt: new Date(), processedMessageLogId: match.messageLogId,
            lastOutcome: result.applied ? "APPLIED" : "ALREADY_CURRENT",
          }});
          processed++;
        }
        return {examined: rows.length, processed, providerCalls: 0 as const};
      }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000});
    } catch (error) {
      if ((error as {code?: string})?.code !== "P2034" || attempt === 2) throw error;
    }
  }
  throw Error("DELIVERY_RECOVERY_RETRIES_EXHAUSTED");
}
