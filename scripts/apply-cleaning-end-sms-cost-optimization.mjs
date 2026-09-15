import { readFileSync, writeFileSync } from "node:fs";

const path = "src/services/messaging.service.ts";
let text = readFileSync(path, "utf8");

const oldBlock = `export function buildCleaningEndSmsBody(params: {\n  staffName?: string | null;\n  propertyName?: string | null;\n  roomName?: string | null;\n  endsAt: Date;\n  timezone?: string | null;\n}): string {\n  return (\n    \`Pin&Go ✅ Limpieza FINALIZADA\\n\` +\n    \`Asignado: \${cleanEnv(params.staffName) ?? "Staff"}\\n\` +\n    \`Propiedad: \${cleanEnv(params.propertyName) ?? "N/A"}\\n\` +\n    \`Unidad: \${cleanEnv(params.roomName) ?? "N/A"}\\n\` +\n    \`Fin: \${fmtWithTimezone(\n      params.endsAt,\n      params.timezone ?? "America/Puerto_Rico",\n      "es"\n    )}\\n\` +\n    \`Acceso expiró automáticamente.\`\n  );\n}\n`;

const newBlock = `export function buildCleaningEndSmsBody(params: {\n  staffName?: string | null;\n  propertyName?: string | null;\n  roomName?: string | null;\n  endsAt: Date;\n  timezone?: string | null;\n}): string {\n  const propertyName =\n    toGsmSafeText(cleanEnv(params.propertyName) ?? "N/A", 24) || "N/A";\n  const roomName =\n    toGsmSafeText(cleanEnv(params.roomName) ?? "N/A", 16) || "N/A";\n  const end = toGsmSafeText(\n    fmtWithTimezone(\n      params.endsAt,\n      params.timezone ?? "America/Puerto_Rico",\n      "en"\n    ),\n    24\n  );\n\n  return (\n    \`Pin&Go cleaning done/lista. \` +\n    \`Prop: \${propertyName}. \` +\n    \`Unit/Unidad: \${roomName}. \` +\n    \`End/Fin: \${end}. \` +\n    \`Access/Acceso ended/finalizado.\`\n  );\n}\n`;

if (!text.includes(oldBlock)) {
  throw new Error("cleaning end SMS block anchor not found");
}

text = text.replace(oldBlock, newBlock);
writeFileSync(path, text);
