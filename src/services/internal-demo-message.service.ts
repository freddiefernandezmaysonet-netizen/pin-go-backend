import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

type Input = { prisma: PrismaClient; reservationId: string; propertyId: string; organizationId: string;
  type: string; to: string; channel: "email" | "sms"; body: string; key?: string;
  send: () => Promise<unknown> };

export function demoMessageState(row: { status?: string | null; providerDeliveryStatus?: string | null }) {
  if (["FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED", "UNDELIVERED"].includes(row.providerDeliveryStatus ?? "")) return "FAILED";
  if (row.providerDeliveryStatus === "DELIVERED") return "DELIVERED";
  if (row.status === "SENT") return "ACCEPTED";
  if (row.status === "DEMO_SENDING" || row.status === "DEMO_UNKNOWN") return "ATTENTION_REQUIRED";
  return row.status ?? "PENDING";
}

// Reserve durably BEFORE contacting a provider. An ambiguous result must not
// be retried blindly: the original message remains available for reconciliation.
export async function sendInternalDemoMessage(input: Input) {
  const id = `demo-mail-${createHash("sha256").update(JSON.stringify([
    input.reservationId, input.type, input.to, input.key ?? "initial",
  ])).digest("hex")}`;
  const result = (row: { status?: string | null; providerDeliveryStatus?: string | null; providerMessageId?: string | null }) => ({
    attempted: true, ok: ["ACCEPTED", "DELIVERED"].includes(demoMessageState(row)),
    status: demoMessageState(row), to: input.to, messageId: id, providerMessageId: row.providerMessageId ?? null,
  });
  try {
    await input.prisma.messageLog.create({ data: { id, reservationId: input.reservationId,
      propertyId: input.propertyId, organizationId: input.organizationId, channel: input.channel,
      to: input.to, body: input.body, provider: input.channel === "email" ? "resend" : "twilio",
      communicationType: input.type, status: "DEMO_SENDING" } });
  } catch (error: any) {
    if (error?.code !== "P2002") throw error;
    return result(await input.prisma.messageLog.findUniqueOrThrow({ where: { id } }));
  }
  try {
    const sent: any = await input.send();
    const providerMessageId = typeof sent === "string" ? sent : sent?.data?.id ?? sent?.id ?? sent?.sid ?? sent?.providerMessageId;
    if (!providerMessageId || sent?.error) throw new Error("DEMO_PROVIDER_ACCEPTANCE_UNCONFIRMED");
    const row = await input.prisma.messageLog.update({ where: { id }, data: {
      status: "SENT", providerMessageId, error: null,
    } });
    await input.prisma.messageDispatchLog.create({ data: { reservationId: input.reservationId,
      type: input.type, channel: input.channel, status: "SENT" } });
    return result(row);
  } catch {
    await input.prisma.messageLog.updateMany({ where: { id, status: "DEMO_SENDING" },
      data: { status: "DEMO_UNKNOWN", error: "Provider result requires reconciliation; automatic resend prevented." } });
    return result(await input.prisma.messageLog.findUniqueOrThrow({ where: { id } }));
  }
}
