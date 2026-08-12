export const CHANNEX_RECOVERABLE_EVENT_TYPES = [
  "booking",
  "booking_new",
  "booking_modification",
  "booking_cancellation",
  "non_acked_booking",
] as const;

const CHANNEX_RECOVERABLE_EVENT_TYPE_SET = new Set<string>(
  CHANNEX_RECOVERABLE_EVENT_TYPES
);

export function isRecoverableChannexBookingEventType(eventType: string) {
  return CHANNEX_RECOVERABLE_EVENT_TYPE_SET.has(
    String(eventType ?? "").trim().toLowerCase()
  );
}

export type RecoverableWebhookEvent = {
  id: string;
  provider: string;
  eventType: string;
  status: "PENDING" | "FAILED" | "PROCESSING";
  attempts: number;
};

export async function processRecoverableWebhookBatch(args: {
  events: RecoverableWebhookEvent[];
  releaseStaleProcessingEvent: (eventId: string) => Promise<boolean>;
  dispatchEvent: (eventId: string) => Promise<unknown>;
  onEventStart?: (event: RecoverableWebhookEvent) => void | Promise<void>;
  onEventError?: (
    event: RecoverableWebhookEvent,
    error: unknown
  ) => void | Promise<void>;
}) {
  let processedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const event of args.events) {
    if (event.status === "PROCESSING") {
      const released = await args.releaseStaleProcessingEvent(event.id);

      if (!released) {
        skippedCount += 1;
        continue;
      }
    }

    await args.onEventStart?.(event);

    try {
      await args.dispatchEvent(event.id);
      processedCount += 1;
    } catch (error) {
      failedCount += 1;
      await args.onEventError?.(event, error);
    }
  }

  return {
    processedCount,
    failedCount,
    skippedCount,
  };
}
