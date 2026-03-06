import { processWebhookEventById } from "../ingest/webhook.processor";

export async function enqueueProcessWebhookEvent(eventId: string) {
  // fire-and-forget (pero seguro)
  setImmediate(() => {
    processWebhookEventById(eventId).catch((e) => {
      console.error("[pms] processWebhookEvent failed", eventId, e?.message ?? e);
    });
  });
}