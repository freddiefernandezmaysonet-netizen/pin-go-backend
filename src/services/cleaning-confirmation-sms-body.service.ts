function toGsmSafeCleaningText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^A-Za-z0-9 .,&'()#*+/:;?%-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildCleaningConfirmationSmsBody(input: {
  propertyName: string;
  roomName: string;
  checkOutText: string;
  confirmUrl: string;
}) {
  const propertyName =
    toGsmSafeCleaningText(input.propertyName, 24) || "property";
  const roomName =
    toGsmSafeCleaningText(input.roomName, 16) || "N/A";
  const checkOutText =
    toGsmSafeCleaningText(input.checkOutText, 24) || "checkout";
  const confirmUrl = String(input.confirmUrl ?? "").trim();

  return (
    `Pin&Go cleaning/limpieza. ` +
    `Property/Propiedad: ${propertyName}. ` +
    `Unit/Unidad: ${roomName}. ` +
    `Check-out: ${checkOutText}. ` +
    `Confirm/Confirma: ${confirmUrl}`
  );
}
