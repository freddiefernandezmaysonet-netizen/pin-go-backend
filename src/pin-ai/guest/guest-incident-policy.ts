import { parsePinAIActionCanaryReservationIds } from "../actions/action-canary-scope.js";

export const GUEST_INCIDENT_CATEGORIES = ["HOT_WATER", "PLUMBING", "ELECTRICITY", "CLIMATE", "ACCESS", "CLEANLINESS", "OTHER"] as const;
export type GuestIncidentCategory = typeof GUEST_INCIDENT_CATEGORIES[number];
export const GUEST_INCIDENT_NOTICE = "PIN_AI_GUEST_INCIDENT_HOST_NOTICE";
export type IncidentEnvironment = Readonly<Record<string, string | undefined>>;

export function guestIncidentEnabled(reservationId: string, env: IncidentEnvironment): boolean {
  const scope = parsePinAIActionCanaryReservationIds(env.PIN_AI_INCIDENT_CANARY_RESERVATION_IDS);
  return env.PIN_AI_INCIDENT_ENABLED === "true" && scope.valid && scope.ids.has(reservationId);
}

export type GuestIncidentReceipt = Readonly<{
  reference: string;
  category: GuestIncidentCategory;
  incidentRecorded: true;
  notification: "QUEUED" | "ACCEPTED" | "DELIVERED" | "ATTENTION_REQUIRED";
  resolution: "OPEN" | "RESOLVED";
  hostAcknowledged: false;
}>;

export function parseIncidentInput(args: Readonly<Record<string, unknown>>) {
  if (Object.keys(args).some(key => !["operation", "category", "guestQuotes"].includes(key)) ||
      !["REPORT", "STATUS"].includes(String(args.operation)) ||
      !GUEST_INCIDENT_CATEGORIES.includes(args.category as GuestIncidentCategory)) {
    throw new Error("PIN_AI_INCIDENT_INPUT_INVALID");
  }
  const quotes = args.guestQuotes ?? [];
  if (!Array.isArray(quotes) || quotes.length > 4 ||
      quotes.some(q => typeof q !== "string" || q.trim().length < 3 || q.length > 500) ||
      (args.operation === "REPORT" && quotes.length === 0) ||
      (args.operation === "STATUS" && quotes.length !== 0)) {
    throw new Error("PIN_AI_INCIDENT_QUOTES_INVALID");
  }
  return { operation: args.operation as "REPORT" | "STATUS", category: args.category as GuestIncidentCategory,
    quotes: [...new Set((quotes as string[]).map(q => q.trim()))] };
}

// No raw error, recipient, provider identifier, or guest credential reaches the model.
export function incidentNotificationState(rows: readonly { status: string | null; providerDeliveryStatus: string | null }[]): GuestIncidentReceipt["notification"] {
  if (!rows.length || rows.some(r =>
    ["FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED"].includes(r.providerDeliveryStatus ?? ""))) return "ATTENTION_REQUIRED";
  if (rows.every(r => r.providerDeliveryStatus === "DELIVERED")) return "DELIVERED";
  if (rows.some(r => r.status === "FAILED_FINAL")) return "ATTENTION_REQUIRED";
  if (rows.every(r => r.status === "SENT" && r.providerDeliveryStatus !== "FAILED")) return "ACCEPTED";
  return "QUEUED";
}

export function formatGuestIncidentReceipt(receipt: GuestIncidentReceipt | null, language: "es" | "en"): string {
  if (!receipt) return language === "es" ? "No hay un incidente registrado de esa categoría para tu reservación." : "There is no recorded incident in that category for your reservation.";
  const es = language === "es";
  const notice = {
    QUEUED: es ? "El aviso al anfitrión está pendiente de envío o reintento." : "The host notice is queued for sending or retry.",
    ACCEPTED: es ? "El proveedor aceptó el aviso; la entrega aún no está confirmada." : "The provider accepted the notice; delivery is not yet confirmed.",
    DELIVERED: es ? "El proveedor confirmó la entrega del correo. Eso no confirma que el anfitrión lo haya leído." : "The provider confirmed email delivery. This does not confirm the host has read it.",
    ATTENTION_REQUIRED: es ? "No hay una notificación completada para todos los destinatarios. El caso sigue visible para atención; si necesitas ayuda inmediata, contacta al anfitrión directamente." : "Notification is not complete for all recipients. The case remains visible for attention; contact the host directly if you need immediate help.",
  }[receipt.notification];
  return es
    ? `Incidente ${receipt.reference}: ${receipt.resolution === "RESOLVED" ? "figura resuelto en el sistema" : "registrado para revisión del anfitrión; pendiente de resolución"}. ${notice}`
    : `Incident ${receipt.reference}: ${receipt.resolution === "RESOLVED" ? "recorded as resolved in the system" : "recorded for host review; resolution pending"}. ${notice}`;
}
