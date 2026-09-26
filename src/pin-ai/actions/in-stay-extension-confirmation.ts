import { InStayExtensionError } from "./in-stay-extension.js";

type Stay = Readonly<{
  checkIn: Date; checkOut: Date; adults: number; children: number;
  selectedAmenityIds: readonly string[];
}>;
type ConfirmedModification = Readonly<{
  guestConfirmation: unknown;
  currentCheckIn: Date; currentCheckOut: Date;
  proposedCheckIn: Date; proposedCheckOut: Date;
  currentAdults: number; currentChildren: number;
  proposedAdults: number; proposedChildren: number;
  currentSelectedAmenityIds: readonly string[];
  proposedSelectedAmenityIds: readonly string[];
}>;

/** Only persisted, confirmed Pin AI terms can opt into in-stay execution. */
export function isConfirmedInStayExtension(input: Readonly<{
  modification: ConfirmedModification;
  reservation: Stay;
  now: Date;
}>): boolean {
  const raw = input.modification.guestConfirmation;
  const evidence = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  if (evidence.operation === undefined) return false;
  const timestamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
  const confirmedAt = timestamp(evidence.confirmedAt);
  const proposalConfirmedAt = timestamp(evidence.actionProposalConfirmedAt);
  if (evidence.operation !== "EXTEND_CHECKOUT_ONLY" || evidence.confirmed !== true ||
      evidence.source !== "PIN_AI_GUEST_SERVICES" ||
      typeof evidence.actionProposalId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(evidence.actionProposalId) ||
      typeof evidence.actionProposalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(evidence.actionProposalFingerprint) ||
      typeof evidence.expectedPreviewFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(evidence.expectedPreviewFingerprint) ||
      evidence.expectedPreviewFingerprint !== evidence.confirmedPreviewFingerprint ||
      !Number.isFinite(confirmedAt) || !Number.isFinite(proposalConfirmedAt) ||
      proposalConfirmedAt > confirmedAt || confirmedAt > input.now.getTime()) {
    throw new InStayExtensionError("EXTENSION_CONFIRMED_PROPOSAL_REQUIRED");
  }
  const { modification: m, reservation: r, now } = input;
  const dates = [r.checkIn, r.checkOut, m.currentCheckIn, m.currentCheckOut, m.proposedCheckIn, m.proposedCheckOut, now];
  if (dates.some((value) => !(value instanceof Date) || !Number.isFinite(value.getTime())) ||
      r.checkIn > now || r.checkOut <= now ||
      m.currentCheckIn.getTime() !== r.checkIn.getTime() || m.currentCheckOut.getTime() !== r.checkOut.getTime() ||
      m.proposedCheckIn.getTime() !== r.checkIn.getTime() || m.proposedCheckOut <= r.checkOut) {
    throw new InStayExtensionError("EXTENSION_STAY_WINDOW_CHANGED");
  }
  const ids = (value: readonly string[]) => JSON.stringify([...value].sort());
  if (m.currentAdults !== r.adults || m.proposedAdults !== r.adults ||
      m.currentChildren !== r.children || m.proposedChildren !== r.children ||
      ids(m.currentSelectedAmenityIds) !== ids(r.selectedAmenityIds) ||
      ids(m.proposedSelectedAmenityIds) !== ids(r.selectedAmenityIds)) {
    throw new InStayExtensionError("EXTENSION_MUST_PRESERVE_CURRENT_STAY");
  }
  return true;
}
