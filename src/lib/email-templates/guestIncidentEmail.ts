export type GuestIncidentEmail = {
  to: string; reference: string; reservationNumber: string; propertyName: string;
  category: string; quotes: string[]; dashboardUrl: string; idempotencyKey: string;
};
function escape(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
export function buildGuestIncidentEmail(input: GuestIncidentEmail) {
  const url = new URL(input.dashboardUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("PIN_AI_INCIDENT_DASHBOARD_URL_INVALID");
  const subject = `Pin AI — Guest incident / Incidente ${input.reference} — ${input.reservationNumber}`.replace(/[\r\n]/g, " ");
  const text = `Guest report / Reporte del huésped\n${input.reference} — ${input.reservationNumber}\n${input.propertyName} — ${input.category}\n\n${input.quotes.join("\n")}\n\nThese are guest statements, not a verified diagnosis. Review and coordinate assistance in Dashboard.\nSon declaraciones del huésped, no un diagnóstico verificado. Revise y coordine la asistencia en Dashboard.\n${url.toString()}\nSign-in required. This email does not approve actions. / Requiere iniciar sesión. Este correo no aprueba acciones.`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escape(subject)}</title></head><body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:640px;margin:auto;padding:24px"><h1>Reporte del huésped / Guest report</h1><p>${escape(input.reference)} · ${escape(input.reservationNumber)}</p><p>${escape(input.propertyName)} · ${escape(input.category)}</p><blockquote>${input.quotes.map(q => `<p>${escape(q)}</p>`).join("")}</blockquote><p>Son declaraciones del huésped, no un diagnóstico verificado. Revise y coordine la asistencia en Dashboard.</p><p lang="en">These are guest statements, not a verified diagnosis. Review and coordinate assistance in Dashboard.</p><p><a href="${escape(url.toString())}">Abrir Dashboard / Open Dashboard</a></p><p>Requiere iniciar sesión. Este correo no aprueba acciones.<br><span lang="en">Sign-in required. This email does not approve actions.</span></p></body></html>`;
  return { subject, text, html };
}
