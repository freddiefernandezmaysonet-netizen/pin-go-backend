import type { readOwnChecklist } from "./cleaning-checklist.service.js";
export type CleanerChecklist = Awaited<ReturnType<typeof readOwnChecklist>>;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function renderCleaningChecklist(checklist: CleanerChecklist | null, token: string, language: "es" | "en") {
  if (!checklist?.items.length) return "";
  const es = language === "es";
  return `<h3>${es ? "Checklist de limpieza" : "Cleaning checklist"}</h3>` + checklist.items.map(item => {
    const label = escape((es ? item.labelEs : item.labelEn) || item.labelEs || item.labelEn);
    const body = `<label style="display:flex;align-items:center;gap:12px;min-height:48px"><input style="width:24px;height:24px;flex-shrink:0" type="checkbox" name="checked" value="true"${item.checked ? " checked" : ""}${checklist.editable ? "" : " disabled"}> ${label}${item.required ? ` <small>(${es ? "obligatorio" : "required"})</small>` : ""}</label>`;
    return checklist.editable ? `<form method="POST" action="/cleaning/confirm/${encodeURIComponent(token)}/checklist/${encodeURIComponent(item.id)}"><input type="hidden" name="version" value="${item.version}">${body}<button class="cleaner-action">${es ? "Guardar punto" : "Save item"}</button></form>` : `<p>${body}</p>`;
  }).join("");
}
