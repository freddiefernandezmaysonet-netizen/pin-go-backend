import { timingSafeEqual } from "node:crypto";
import { InboxError, validId, type Scope } from "./host-inbox.js";

export const AI_WEBHOOK_PATH = "/webhooks/ota/channex/messages";
export const AI_WEBHOOK_HEADER = "x-pin-go-channex-messages-secret";
export function autoConfig(env: NodeJS.ProcessEnv) {
  const list = (s?: string) => (s ?? "").split(",").map(v => v.trim()).filter(Boolean);
  const organizations = list(env.PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS), properties = list(env.PIN_AI_CHANNEX_AUTO_PROPERTY_IDS);
  const value = env.PIN_AI_CHANNEX_AUTO_START_AT ?? "";
  const since = new Date(value);
  const enabled = env.PIN_AI_CHANNEX_AUTO_ENABLED === "true" && /Z$/.test(value) && Number.isFinite(since.getTime()) &&
    organizations.length > 0 && organizations.length <= 50 && properties.length > 0 && properties.length <= 50 &&
    ![...organizations, ...properties].includes("*");
  return { enabled, since, allows: (scope: Scope) => enabled && organizations.includes(scope.organizationId) && properties.includes(scope.propertyId) };
}
export function validWebhookSecret(expected: string | undefined, received: unknown): boolean {
  if (!expected || expected.length < 32 || typeof received !== "string" || received.length > 512) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function parseMessageEvent(raw: unknown) {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxError("PIN_AI_MESSAGE_EVENT_INVALID", 400);
    return value as Record<string, unknown>;
  };
  const body = object(raw);
  if (body.event !== "message") return null;
  const payload = object(body.payload);
  if (payload.sender !== "guest" && payload.sender !== "property") throw new InboxError("PIN_AI_MESSAGE_EVENT_INVALID", 400);
  const ids = [body.property_id, payload.id, payload.message_thread_id];
  if (ids.some(v => typeof v !== "string" || !validId(v)) || (payload.property_id !== undefined && payload.property_id !== body.property_id)) throw new InboxError("PIN_AI_MESSAGE_EVENT_INVALID", 400);
  // Neither the text, timestamp, booking ID nor sender authorizes any action; worker re-fetches the message.
  return { externalPropertyId: String(body.property_id), messageId: String(payload.id), threadId: String(payload.message_thread_id) };
}
