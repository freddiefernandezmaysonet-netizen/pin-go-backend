function toGsmSafeCleaningReadyText(value: unknown, maxLength: number) {
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

export function buildCleaningReadySmsBody(input: {
  propertyName: string;
  roomName: string;
  start: string;
  end: string;
}) {
  const propertyName =
    toGsmSafeCleaningReadyText(input.propertyName, 24) || "Property";
  const roomName =
    toGsmSafeCleaningReadyText(input.roomName, 16) || "N/A";
  const start =
    toGsmSafeCleaningReadyText(input.start, 24) || "start";
  const end =
    toGsmSafeCleaningReadyText(input.end, 24) || "end";

  return (
    `Pin&Go cleaning ready/lista. ` +
    `Prop: ${propertyName}. ` +
    `Unit/Unidad: ${roomName}. ` +
    `Window/Ventana: ${start}-${end}.`
  );
}
