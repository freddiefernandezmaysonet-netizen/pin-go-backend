import { dispatchPmsWebhookEventById } from "../ingest/webhook.dispatcher";

export async function enqueueProcessWebhookEvent(eventId: string) {
  console.log("[pms] enqueueProcessWebhookEvent", { eventId });

  setImmediate(() => {
    console.log("[pms] setImmediate fired", { eventId });

    dispatchPmsWebhookEventById(eventId).catch((e) => {
      console.error(
        "[pms] dispatchPmsWebhookEvent failed",
        eventId,
        e?.message ?? e
      );
    });
  });
}
