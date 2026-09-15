import { readFileSync, writeFileSync } from "node:fs";

const path = "src/services/manual-reservation-cleaner-cancellation-notification.service.ts";
let text = readFileSync(path, "utf8");

const oldFormatter = `function formatStayDate(\n  value: Date,\n  timeZone: string\n) {\n  return new Intl.DateTimeFormat("en-US", {\n    timeZone,\n    year: "numeric",\n    month: "2-digit",\n    day: "2-digit",\n    hour: "2-digit",\n    minute: "2-digit",\n    hour12: true,\n  }).format(value);\n}\n`;

const newFormatter = `function toGsmSafeManualCleanerCancellationText(\n  value: unknown,\n  maxLength: number\n) {\n  return String(value ?? "")\n    .normalize("NFKD")\n    .replace(/[\\u0300-\\u036f]/g, "")\n    .replace(/[“”]/g, '\"')\n    .replace(/[‘’]/g, "'")\n    .replace(/[–—]/g, "-")\n    .replace(/[^A-Za-z0-9 .,&'()#*+/:;?%-]/g, "")\n    .replace(/\\s+/g, " ")\n    .trim()\n    .slice(0, maxLength);\n}\n\nfunction formatCompactStayDate(\n  value: Date,\n  timeZone: string\n) {\n  return new Intl.DateTimeFormat("en-US", {\n    timeZone,\n    month: "2-digit",\n    day: "2-digit",\n    hour: "2-digit",\n    minute: "2-digit",\n    hour12: true,\n  })\n    .format(value)\n    .replace(",", "")\n    .replace(/\\s+/g, " ")\n    .trim();\n}\n\nexport function buildManualCleanerCancellationSmsBody(input: {\n  reservationNumber: string;\n  propertyName: string;\n  checkIn: Date;\n  checkOut: Date;\n  timeZone: string;\n}) {\n  const reservationNumber =\n    toGsmSafeManualCleanerCancellationText(input.reservationNumber, 24) ||\n    "N/A";\n  const propertyName =\n    toGsmSafeManualCleanerCancellationText(input.propertyName, 20) ||\n    "Property";\n  const checkIn = toGsmSafeManualCleanerCancellationText(\n    formatCompactStayDate(input.checkIn, input.timeZone),\n    16\n  );\n  const checkOut = toGsmSafeManualCleanerCancellationText(\n    formatCompactStayDate(input.checkOut, input.timeZone),\n    16\n  );\n\n  return (\n    \`Pin&Go clean cancelled/cancelada. \` +\n    \`Res: \${reservationNumber}. \` +\n    \`Prop: \${propertyName}. \` +\n    \`Stay: \${checkIn}-\${checkOut}. \` +\n    \`No cleaning/no limpieza.\`\n  );\n}\n`;

if (!text.includes(oldFormatter)) {
  throw new Error("stay date formatter anchor not found");
}
text = text.replace(oldFormatter, newFormatter);

const oldBody = `  const checkIn = formatStayDate(\n    reservation.checkIn,\n    timeZone\n  );\n  const checkOut = formatStayDate(\n    reservation.checkOut,\n    timeZone\n  );\n\n  const spanish =\n    \`🧼 Pin&Go — Limpieza cancelada\\n\` +\n    \`La reservación #\${reservationNumber} fue cancelada por el anfitrión.\\n\` +\n    \`Propiedad: \${propertyName}\\n\` +\n    \`Entrada: \${checkIn}\\n\` +\n    \`Salida: \${checkOut}\\n\\n\` +\n    \`No se requiere la limpieza asociada a esta reservación.\`;\n\n  const english =\n    \`🧼 Pin&Go — Cleaning cancelled\\n\` +\n    \`Reservation #\${reservationNumber} was cancelled by the host.\\n\` +\n    \`Property: \${propertyName}\\n\` +\n    \`Check-in: \${checkIn}\\n\` +\n    \`Check-out: \${checkOut}\\n\\n\` +\n    \`The cleaning associated with this reservation is no longer required.\`;\n\n  const body = \`\${spanish}\\n\\n---\\n\\n\${english}\`;\n`;

const newBody = `  const body = buildManualCleanerCancellationSmsBody({\n    reservationNumber: String(reservationNumber),\n    propertyName,\n    checkIn: reservation.checkIn,\n    checkOut: reservation.checkOut,\n    timeZone,\n  });\n`;

if (!text.includes(oldBody)) {
  throw new Error("manual cleaner cancellation body anchor not found");
}
text = text.replace(oldBody, newBody);

writeFileSync(path, text);
