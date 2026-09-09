import {
  CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK,
  CHANNEX_CHANNEL_LIFECYCLE_EVENTS,
  type ChannexChannelLifecycleEventType,
} from "./channex-channel-lifecycle.evidence.js";

export const OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_PATH =
  "/webhooks/ota/channex/channel-lifecycle";

export const OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER =
  "x-pin-go-ota-channel-webhook-secret";

export const OTA_CHANNEL_LIFECYCLE_WEBHOOK_SEND_DATA = true;

export const OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK =
  CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK;

const EVENT_SET = new Set<string>(CHANNEX_CHANNEL_LIFECYCLE_EVENTS);
const CHANNEX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ChannexChannelLifecycleWebhookContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChannexChannelLifecycleWebhookContractError";
  }
}

export function normalizeChannexUuid(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CHANNEX_UUID.test(normalized) ? normalized : null;
}

function requiredChannexUuid(value: unknown, code: string): string {
  const normalized = normalizeChannexUuid(value);
  if (!normalized) {
    throw new ChannexChannelLifecycleWebhookContractError(code);
  }
  return normalized;
}

function requiredSecret(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(normalized)) {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_REQUIRED"
    );
  }
  return normalized;
}

export function normalizeOtaChannelLifecycleWebhookCallbackUrl(
  value: unknown
): string {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_PATH ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_INVALID"
    );
  }
}

export function parseOtaChannelLifecycleEventMask(
  value: unknown
): readonly ChannexChannelLifecycleEventType[] {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_INVALID"
    );
  }
  if (raw === "*" || raw.split(";").some((item) => item.trim() === "*")) {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_WILDCARD_FORBIDDEN"
    );
  }

  const values = raw.split(";").map((item) => item.trim());
  if (values.some((item) => !item) || new Set(values).size !== values.length) {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_INVALID"
    );
  }
  if (values.some((item) => !EVENT_SET.has(item))) {
    throw new ChannexChannelLifecycleWebhookContractError(
      "OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_MIXED"
    );
  }

  return values as ChannexChannelLifecycleEventType[];
}

export function hasCompleteOtaChannelLifecycleEventMask(value: unknown): boolean {
  const values = parseOtaChannelLifecycleEventMask(value);
  return (
    values.length === CHANNEX_CHANNEL_LIFECYCLE_EVENTS.length &&
    CHANNEX_CHANNEL_LIFECYCLE_EVENTS.every((event) => values.includes(event))
  );
}

export type ChannexChannelLifecycleWebhookWritePayload = {
  webhook: {
    property_id: string;
    callback_url: string;
    event_mask: string;
    headers: Record<string, string>;
    is_active: true;
    send_data: true;
  };
};

export function buildChannexChannelLifecycleWebhookPayload(args: {
  externalPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
}): ChannexChannelLifecycleWebhookWritePayload {
  const externalPropertyId = requiredChannexUuid(
    args.externalPropertyId,
    "OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED"
  );
  const callbackUrl = normalizeOtaChannelLifecycleWebhookCallbackUrl(
    args.callbackUrl
  );
  const webhookSecret = requiredSecret(args.webhookSecret);

  return {
    webhook: {
      property_id: externalPropertyId,
      callback_url: callbackUrl,
      event_mask: OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
      headers: {
        [OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER]: webhookSecret,
      },
      is_active: true,
      send_data: OTA_CHANNEL_LIFECYCLE_WEBHOOK_SEND_DATA,
    },
  };
}
