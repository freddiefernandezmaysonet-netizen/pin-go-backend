import { assertRuntimeResponseSafe } from "./policy.js";

// Operational status belongs to the canonical receipt, not model narration.
// A rejected narration falls back to that receipt after the turn completes.
const INCIDENT_STATUS_ASSERTIONS = [
  /\b(?:i(?:'|’)ve|i have|i) (?:recorded|registered|created|opened|closed|resolved)\b/i,
  /\b(?:he|hemos) (?:registrado|creado|abierto|cerrado|resuelto)\b|\b(?:registr[eé]|registramos|cre[eé]|creamos|resolv[ií]|resolvimos)\b/i,
  /\b(?:the|your|this) (?:incident|report|case|issue|problem) (?:is|was|has been) (?:open|closed|resolved|fixed|recorded|registered|created)\b/i,
  /\b(?:el|tu|su|este) (?:incidente|reporte|caso|problema) (?:esta|está|fue|ha sido|quedo|quedó) (?:abierto|cerrado|resuelto|reparado|registrado|creado)\b/i,
  /\b(?:the|your) (?:notice|notification|email|message) (?:was|has been|is) (?:sent|delivered|received|read|pending)\b/i,
  /\b(?:el|tu|su) (?:aviso|correo|mensaje) (?:fue|ha sido|esta|está|se ha|quedo|quedó) (?:enviado|entregado|recibido|leido|leído|pendiente)\b/i,
  /\b(?:the|your) host (?:has |had )?(?:read|received|acknowledged)\b/i,
  /\b(?:el|tu|su) anfitri[oó]n (?:ya |ha |hab[ií]a )?(?:ley[oó]|le[ií]do|recibi[oó]|recibido|confirm[oó] que recibi[oó])\b/i,
];

export function composeGuestIncidentReply(modelText: string, receiptText: string): string {
  const receipt = receiptText.trim();
  if (!receipt) throw new Error("PIN_AI_INCIDENT_RECEIPT_REQUIRED");
  const narrative = modelText.split(receiptText).join("").trim();
  if (!narrative || narrative.length > 4000 || /\bGI-[A-Z0-9]+\b/i.test(narrative) ||
      INCIDENT_STATUS_ASSERTIONS.some(pattern => pattern.test(narrative))) return receipt;
  try {
    assertRuntimeResponseSafe({ responseText: narrative, escalationCreated: false,
      toolCalls: [], requiresHumanReview: false });
  } catch {
    return receipt;
  }
  return `${narrative}\n\n${receipt}`;
}

export function hasCanonicalGuestIncidentReply(reply: string, receiptText: string): boolean {
  const receipt = receiptText.trim();
  if (reply === receipt) return true;
  const suffix = `\n\n${receipt}`;
  if (!reply.endsWith(suffix)) return false;
  return composeGuestIncidentReply(reply.slice(0, -suffix.length), receiptText) === reply;
}
