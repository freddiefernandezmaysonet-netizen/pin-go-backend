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
  hostAcknowledged: boolean;
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

export function formatGuestIncidentReceipt(receipt: GuestIncidentReceipt | null, language: "es" | "en", operation: "REPORT" | "STATUS" = "REPORT"): string {
  if (!receipt) return language === "es" ? "Todavía no encuentro un reporte registrado sobre ese problema en tu reservación. Cuéntame qué está ocurriendo para poder ayudarte." : "I cannot find a report about that issue for your reservation yet. Please tell me what is happening so I can help.";
  const es = language === "es";
  const opening = operation === "REPORT"
    ? (es ? "Lamento que estés teniendo este inconveniente. Gracias por avisarnos. " : "I’m sorry you’re experiencing this inconvenience. Thank you for letting us know. ")
    : "";
  if (receipt.resolution === "RESOLVED") return opening + (es
    ? `Tu reporte figura como resuelto. Si el problema continúa, cuéntame qué está ocurriendo para darle seguimiento. Referencia: ${receipt.reference}.`
    : `Your report is marked as resolved. If the problem continues, please tell me what is happening so we can follow up. Reference: ${receipt.reference}.`);
  const notice = {
    QUEUED: es ? "El aviso al anfitrión está pendiente de envío." : "The notice to your host is waiting to be sent.",
    ACCEPTED: es ? "El aviso al anfitrión está en proceso de entrega; todavía no tenemos confirmación de que haya llegado." : "The notice to your host is on its way; we do not have delivery confirmation yet.",
    DELIVERED: es ? "El aviso llegó al correo del anfitrión." : "The notice reached your host’s email.",
    ATTENTION_REQUIRED: es ? "No se ha podido completar el aviso al anfitrión, pero tu reporte quedó registrado. Si necesitas ayuda inmediata, comunícate directamente con él." : "We have not been able to complete the notice to your host, but your report has been saved. If you need immediate help, please contact your host directly.",
  }[receipt.notification];
  const progress = receipt.hostAcknowledged
    ? (es ? "El anfitrión confirmó que recibió tu reporte. El caso sigue abierto." : "Your host confirmed that they received your report. The case is still open.")
    : notice;
  return opening + (es
    ? `${operation === "REPORT" ? "Registré tu reporte para que el anfitrión pueda ayudarte." : "Tu reporte sigue abierto."} ${progress} Referencia: ${receipt.reference}.`
    : `${operation === "REPORT" ? "I’ve recorded your report so your host can help." : "Your report is still open."} ${progress} Reference: ${receipt.reference}.`);
}
