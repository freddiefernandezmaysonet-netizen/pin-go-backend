import { prisma } from "../../lib/prisma";
import { dispatchPmsWebhookEventById } from "../ingest/webhook.dispatcher";
import { getPmsWebhookExecutionTarget } from "./pms-webhook-execution.policy";

export async function enqueueProcessWebhookEvent(eventId: string) {
  console.log("[pms] enqueueProcessWebhookEvent", { eventId });

  const event = await prisma.webhookEventIngest.findUnique({
    where: { id: eventId },
    select: { provider: true },
  });

  if (!event) {
    console.error("[pms] webhook event not found for enqueue", { eventId });
    return;
  }

  const target = getPmsWebhookExecutionTarget(event.provider);

  if (target === "STANDALONE_RECOVERY_WORKER") {
    console.log("[pms] durable worker handoff", {
      eventId,
      provider: event.provider,
    });
    return;
  }

  setImmediate(() => {
    console.log("[pms] legacy setImmediate fired", {
      eventId,
      provider: event.provider,
    });

    dispatchPmsWebhookEventById(eventId).catch((error) => {
      console.error(
        "[pms] dispatchPmsWebhookEvent failed",
        eventId,
        error?.message ?? error
      );
    });
  });
}
