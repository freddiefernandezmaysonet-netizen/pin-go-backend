export type CleaningHostAttentionEmail = Readonly<{
  to: string[];
  propertyName: string;
  cleanerName: string;
  reservationNumber: string | null;
  dashboardUrl: string;
}>;

export function buildCleaningHostAttentionEmail(input: CleaningHostAttentionEmail) {
  const reservation = input.reservationNumber ? ` Reservation / Reservacion #${input.reservationNumber}.` : "";
  return {
    subject: "Pin&Go: cleaning confirmation needs attention / confirmacion pendiente",
    text:
      `Pin&Go has not received the cleaner's completion confirmation for ${input.propertyName} after the agreed follow-up window.` +
      reservation +
      ` Cleaner: ${input.cleanerName}. This does not confirm that cleaning was not completed. Review the work in Mission Control: ${input.dashboardUrl}`,
  };
}
