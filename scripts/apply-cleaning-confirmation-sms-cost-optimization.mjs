import { readFileSync, writeFileSync } from "node:fs";

const path = "src/services/cleaning-confirmation-dispatch.service.ts";
let text = readFileSync(path, "utf8");

const importAnchor = 'import { selectNextStaffForProperty } from "./staff-selection.service";\n';
const importLine = 'import { buildCleaningConfirmationSmsBody } from "./cleaning-confirmation-sms-body.service";\n';
if (!text.includes(importAnchor)) throw new Error("import anchor not found");
text = text.replace(importAnchor, importAnchor + importLine);

const oldBlock = `  const roomName = reservation.roomName ?? "N/A";\n  const staffName = staff.fullName ?? "Staff";\n\n  const checkOutText = new Intl.DateTimeFormat("en-US", {\n    timeZone: timezone,\n    year: "numeric",\n    month: "2-digit",\n    day: "2-digit",\n    hour: "2-digit",\n    minute: "2-digit",\n    hour12: true,\n  }).format(new Date(reservation.checkOut));\n\n  const es =\n    \`🧼 Pin&Go Solicitud de limpieza\\n\` +\n    \`Asignado: \${staffName}\\n\` +\n    \`Propiedad: \${propertyName}\\n\` +\n    \`Unidad: \${roomName}\\n\` +\n    \`Check-out: \${checkOutText}\\n\\n\` +\n    \`Confirma si estás disponible:\\n\${confirmUrl}\`;\n\n  const en =\n    \`🧼 Pin&Go Cleaning request\\n\` +\n    \`Assigned: \${staffName}\\n\` +\n    \`Property: \${propertyName}\\n\` +\n    \`Unit: \${roomName}\\n\` +\n    \`Check-out: \${checkOutText}\\n\\n\` +\n    \`Confirm if you are available:\\n\${confirmUrl}\`;\n\n  const body = \`\${es}\\n\\n---\\n\\n\${en}\`;\n`;

const newBlock = `  const roomName = reservation.roomName ?? "N/A";\n\n  const checkOutText = new Intl.DateTimeFormat("en-US", {\n    timeZone: timezone,\n    year: "numeric",\n    month: "2-digit",\n    day: "2-digit",\n    hour: "2-digit",\n    minute: "2-digit",\n    hour12: true,\n  }).format(new Date(reservation.checkOut));\n\n  const body = buildCleaningConfirmationSmsBody({\n    propertyName,\n    roomName,\n    checkOutText,\n    confirmUrl,\n  });\n`;

if (!text.includes(oldBlock)) throw new Error("message block anchor not found");
text = text.replace(oldBlock, newBlock);
writeFileSync(path, text);
