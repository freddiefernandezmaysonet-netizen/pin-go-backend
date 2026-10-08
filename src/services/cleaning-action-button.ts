import { assertCleaningActionTime, type CleaningActionWindow } from "./cleaning-action-window.js";

/** Cancellation closes at the window start even without a Start declaration. */
export function renderCleaningCancellation(input: { token: string; language: "es" | "en"; window: CleaningActionWindow | null; now?: Date }) {
  const now = input.now ?? new Date();
  const start = input.window?.startsAt.getTime();
  if (!start || !Number.isFinite(start) || !Number.isFinite(now.getTime()) || now.getTime() >= start) return "";
  const es = input.language === "es";
  return `<details id="cleaning-cancellation"><summary>${es ? "Cancelar limpieza" : "Cancel cleaning"}</summary><p>${es ? "Confirma si ya no puedes realizar esta limpieza. Pin&Go buscará un respaldo." : "Confirm if you can no longer perform this cleaning. Pin&Go will look for a backup."}</p><form method="POST" action="/cleaning/confirm/${encodeURIComponent(input.token)}/cancel"><button class="cleaner-action cleaner-action-secondary">${es ? "Sí, cancelar limpieza" : "Yes, cancel cleaning"}</button></form></details><script>(()=>{const d=document.getElementById("cleaning-cancellation"),base=${now.getTime()},origin=performance.now(),start=${start};function update(){d.hidden=base+performance.now()-origin>=start;d.querySelector("button").disabled=d.hidden;}d.querySelector("form").addEventListener("submit",e=>{update();if(d.hidden)e.preventDefault();});setInterval(update,1000);document.addEventListener("visibilitychange",update);window.addEventListener("pageshow",update);update();})()</script>`;
}

/** One action per portal view; server remains authoritative on every POST. */
export function renderCleaningActionButton(input: { token: string; action: "start" | "complete"; window: CleaningActionWindow | null; startedAt: Date | null; language: "es" | "en"; now?: Date; blockedReason?: string }) {
  const { action, window, language } = input;
  const es = language === "es";
  const now = input.now ?? new Date();
  let allowed = false;
  try { if (window && !input.blockedReason) { assertCleaningActionTime(window, action, now, input.startedAt); allowed = true; } } catch { /* Disabled until a valid window. */ }
  const early = es ? "Disponible desde el inicio programado. Actualiza la página si cambió el horario." : "Available from the scheduled start. Refresh if the schedule changed.";
  const closed = es ? "La ventana para esta acción cerró. La limpieza no se marca completada automáticamente." : "The window for this action closed. Cleaning is not automatically marked complete.";
  const unavailable = es ? "No se pudo validar el horario. Actualiza la página." : "Could not validate the schedule. Refresh this page.";
  const start = window ? Math.max(window.startsAt.getTime(), action === "complete" ? input.startedAt?.getTime() ?? Infinity : -Infinity) : null;
  const end = window ? (action === "start" ? window.latestStartAt : window.latestCompletionAt)?.getTime() ?? null : null;
  const reason = input.blockedReason || (!window ? unavailable : start! > now.getTime() ? early : closed);
  const id = `cleaning-action-${action}`;
  const label = action === "start" ? (es ? "Comencé la limpieza" : "I started cleaning") : (es ? "Terminé la limpieza" : "I finished cleaning");
  const html = `<form method="POST" action="/cleaning/confirm/${encodeURIComponent(input.token)}/${action}"><button id="${id}" class="cleaner-action"${allowed ? "" : " disabled"}>${label}</button></form><p id="${id}-note" class="cleaner-note" role="status">${allowed ? "" : reason}</p>`;
  if (!window || !Number.isFinite(start) || input.blockedReason) return html;
  // Monotonic elapsed time avoids depending on the cleaner's wall-clock setting.
  // Both the click handler and the server reject actions after the deadline.
  return html + `<script>(()=>{const b=document.getElementById(${JSON.stringify(id)}),n=document.getElementById(${JSON.stringify(id + "-note")}),base=${now.getTime()},origin=performance.now(),start=${start},end=${end ?? "null"};function update(){const t=base+performance.now()-origin;b.disabled=t<start||(end!==null&&t>=end);n.textContent=b.disabled?(t<start?${JSON.stringify(early)}:${JSON.stringify(closed)}):"";}b.form.addEventListener("submit",e=>{update();if(b.disabled)e.preventDefault();});setInterval(update,1000);document.addEventListener("visibilitychange",update);window.addEventListener("pageshow",update);update();})()</script>`;
}
