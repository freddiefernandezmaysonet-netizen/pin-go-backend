import { processWebhookEventById } from "../ingest/webhook.processor";

export async function enqueueProcessWebhookEvent(eventId: string) {
  console.log("[pms] enqueueProcessWebhookEvent", { eventId });

  setImmediate(() => {
    console.log("[pms] setImmediate fired", { eventId });

    processWebhookEventById(eventId).catch((e) => {
      console.error("[pms] processWebhookEvent failed", eventId, e?.message ?? e);
    });
  });
}