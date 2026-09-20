import {
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
  type PinAIRuntimeResponse,
  type PinAIRuntimeToolName,
} from "./contracts.js";

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
    assertRuntimeToolEnabled(call.name);
    assertNoForbiddenKeys(call.arguments, ["toolCalls", call.name]);
  }

  assertNoForbiddenKeys(response, ["response"]);
  assertNoFalseCompletionClaims(response);
}

export function assertRuntimeToolEnabled(
  toolName: PinAIRuntimeToolName,
): void {
  if (!isPinAIRuntimeToolEnabled(toolName)) {
    throw new Error(`PIN_AI_RUNTIME_TOOL_NOT_ENABLED:${toolName}`);
  }
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


function assertNoFalseCompletionClaims(response: PinAIRuntimeResponse): void {
  const text = response.responseText
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const falseCompletionPatterns = [
    /\bi(?:'|’)ve (?:sent|submitted|forwarded|escalated|contacted|notified|informed)\b/,
    /\bi have (?:sent|submitted|forwarded|escalated|contacted|notified|informed)\b/,
    /\bi (?:sent|submitted|forwarded|escalated|contacted|notified|informed) (?:a|an|the|this|your)\b/,
    /\b(?:the|this|your) request (?:was|has been) (?:sent|submitted|forwarded|escalated)\b/,
    /\bthe (?:host|issue) (?:was|has been) (?:contacted|notified|informed|escalated)\b/,
    /\b(?:he|hemos) (?:enviado|enviada|presentado|presentada|remitido|remitida|escalado|escalada|contactado|contactada|notificado|notificada|avisado|avisada)\b/,
    /\b(?:ya |le |lo |la )?(?:envie|enviamos|presente|presentamos|remiti|remitimos|escale|escalamos|contacte|contactamos|notifique|notificamos|avise|avisamos)\b/,
    /\b(?:la|el|tu|su) (?:solicitud|pedido|anfitrion|host) (?:fue|ha sido) (?:enviado|enviada|presentado|presentada|remitido|remitida|escalado|escalada|contactado|contactada|notificado|notificada|avisado|avisada)\b/,
    /\b(?:your|the) (?:early check-?in|late check-?out|stay extension|extension) (?:is|was|has been) (?:approved|confirmed|authorized|booked|completed)\b/,
    /\b(?:la|el|tu|su) (?:entrada temprana|check-?in temprano|salida tardia|check-?out tardio|extension) (?:esta|fue|ha sido) (?:aprobado|aprobada|confirmado|confirmada|autorizado|autorizada|completado|completada)\b/,
    /\b(?:your|the) (?:reservation|stay) (?:is|was|has been) (?:changed|extended|updated|modified)\b/,
    /\b(?:la|tu|su) (?:reservacion|reserva|estadia) (?:esta|fue|ha sido) (?:cambiada|extendida|actualizada|modificada)\b/,
    /\b(?:you(?:'|’)ve|you have) been charged\b/,
    /\bi(?:'|’)ve charged\b/,
    /\bi have charged\b/,
    /\b(?:the|your) (?:payment|charge) (?:was|has been) (?:processed|completed|collected)\b/,
    /\b(?:te|le|se le) (?:cobre|cobramos|cargue|cargamos)\b/,
    /\b(?:el|tu|su) (?:pago|cargo) (?:fue|ha sido|se ha) (?:procesado|completado|realizado|cobrado)\b/,
    /\b(?:the|your) (?:extension )?price (?:is|was|has been) (?:final|confirmed|locked in)\b/,
    /\b(?:el|tu|su) precio (?:de extension )?(?:es|fue|ha sido) (?:final|confirmado)\b/,
  ];

  if (
    response.escalationCreated === false &&
    falseCompletionPatterns.some((pattern) => pattern.test(text))
  ) {
    throw new Error("PIN_AI_RUNTIME_FALSE_COMPLETION_CLAIM");
  }
}
