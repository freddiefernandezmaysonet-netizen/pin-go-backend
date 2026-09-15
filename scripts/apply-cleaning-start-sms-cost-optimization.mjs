import { readFileSync, writeFileSync } from "node:fs";

const path = "src/services/messaging.service.ts";
let text = readFileSync(path, "utf8");

const oldBlock = `export function buildCleaningStartSmsBody(params: {\n  staffName?: string | null;\n  propertyName?: string | null;\n  roomName?: string | null;\n  startsAt: Date;\n  endsAt: Date;\n  timezone?: string | null;\n}): string {\n  return (\n    \`Pin&Go - Limpieza INICIADA\\n\` +\n    \`Asignado: \${cleanEnv(params.staffName) ?? "Staff"}\\n\` +\n    \`Propiedad: \${cleanEnv(params.propertyName) ?? "N/A"}\\n\` +\n    \`Unidad: \${cleanEnv(params.roomName) ?? "N/A"}\\n\` +\n    \`Inicio: \${fmtWithTimezone(\n      params.startsAt,\n      params.timezone ?? "America/Puerto_Rico",\n      "es"\n      )}\\n\` +\n     \`Fin: \${fmtWithTimezone(\n       params.endsAt,\n       params.timezone ?? "America/Puerto_Rico",\n       "es"\n     )}\\n\` +\n    \`Su tarjeta NFC esta activa unicamente durante esta ventana.\`\n  );\n}\n`;

const newBlock = `export function buildCleaningStartSmsBody(params: {\n  staffName?: string | null;\n  propertyName?: string | null;\n  roomName?: string | null;\n  startsAt: Date;\n  endsAt: Date;\n  timezone?: string | null;\n}): string {\n  const propertyName =\n    toGsmSafeText(cleanEnv(params.propertyName) ?? "N/A", 20) || "N/A";\n  const roomName =\n    toGsmSafeText(cleanEnv(params.roomName) ?? "N/A", 12) || "N/A";\n  const start = toGsmSafeText(\n    fmtWithTimezone(\n      params.startsAt,\n      params.timezone ?? "America/Puerto_Rico",\n      "en"\n    ),\n    22\n  );\n  const end = toGsmSafeText(\n    fmtWithTimezone(\n      params.endsAt,\n      params.timezone ?? "America/Puerto_Rico",\n      "en"\n    ),\n    22\n  );\n\n  return (\n    \`Pin&Go clean start/inicio. \` +\n    \`Prop: \${propertyName}. \` +\n    \`Unit: \${roomName}. \` +\n    \`Window: \${start}-\${end}. \` +\n    \`NFC active/activa.\`\n  );\n}\n`;

if (!text.includes(oldBlock)) {
  throw new Error("cleaning start SMS block anchor not found");
}

text = text.replace(oldBlock, newBlock);
writeFileSync(path, text);
