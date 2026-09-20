import {
  PIN_AI_RUNTIME_TOOLS,
  type PinAIRuntimeRequest,
  type PinAIRuntimeResponse,
  type PinAIRuntimeToolName,
} from "./contracts.js";

const TOOL_NAMES = new Set<PinAIRuntimeToolName>(
  PIN_AI_RUNTIME_TOOLS.map((tool) => tool.name),
);

const FORBIDDEN_RESPONSE_KEYS = [
  "activePasscode",
  "futurePasscode",
  "nfcCredential",
  "stripeSecret",
  "paymentMethod",
  "identityDocument",
  "governmentId",
  "refundAuthorization",
] as const;

export function assertRuntimeRequestScoped(request: PinAIRuntimeRequest): void {
  const { organizationId, propertyId, reservationId, guestId } = request.context;

  if (!organizationId || !propertyId || !reservationId || !guestId) {
    throw new Error("PIN_AI_RUNTIME_CONTEXT_INCOMPLETE");
  }

  if (request.conversation.length === 0) {
    throw new Error("PIN_AI_RUNTIME_CONVERSATION_EMPTY");
  }
}

export function assertRuntimeResponseSafe(response: PinAIRuntimeResponse): void {
  for (const call of response.toolCalls) {
    if (!TOOL_NAMES.has(call.name)) {
      throw new Error(`PIN_AI_RUNTIME_TOOL_NOT_ALLOWED:${call.name}`);
    }
    assertNoForbiddenKeys(call.arguments, ["toolCalls", call.name]);
  }

  assertNoForbiddenKeys(response, ["response"]);
}

export function assertNoDirectIrreversibleAction(toolName: string): void {
  const forbidden = new Set([
    "cancel_reservation",
    "issue_refund",
    "charge_guest",
    "create_access_credential",
    "activate_access_credential",
    "change_reservation_dates",
  ]);

  if (forbidden.has(toolName)) {
    throw new Error(`PIN_AI_RUNTIME_DIRECT_IRREVERSIBLE_ACTION_FORBIDDEN:${toolName}`);
  }
}

function assertNoForbiddenKeys(value: unknown, path: string[]): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, [...path, String(index)]));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESPONSE_KEYS.includes(key as (typeof FORBIDDEN_RESPONSE_KEYS)[number])) {
      throw new Error(`PIN_AI_RUNTIME_FORBIDDEN_FIELD:${[...path, key].join(".")}`);
    }
    assertNoForbiddenKeys(nested, [...path, key]);
  }
}
