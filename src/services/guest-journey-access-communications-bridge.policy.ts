import { createHash } from "node:crypto";

export type GuestAccessCommunicationChannel = "email" | "sms";

export type GuestAccessCommunicationOutboxInput = {
  organizationId: string;
  propertyId: string;
  reservationId: string;
  reservationNumber: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  preferredLanguage: string | null;
  externalRaw: unknown;
  accessGrantId: string;
  accessCodeHash: string;
  validFrom: Date;
  validUntil: Date;
};

export type PendingGuestAccessMessage = {
  id: string;
  channel: GuestAccessCommunicationChannel;
  to: string;
  from: null;
  body: string;
  provider: "resend" | "twilio";
  providerMessageId: null;
  status: "APMS_PENDING";
  accessGrantId: string;
  error: null;
  retryCount: 0;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  communicationType: "GUEST_ACCESS_PASSCODE";
};

export type ExistingGuestAccessDeliveryEvidence = {
  channel: string;
  to: string;
  status: string | null;
  accessGrantId: string | null;
  body: string;
  createdAt: Date;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function hasGuestSmsConsent(externalRaw: unknown): boolean {
  if (!externalRaw || typeof externalRaw !== "object" || Array.isArray(externalRaw)) return false;
  const consent = (externalRaw as Record<string, unknown>).consent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return false;
  const record = consent as Record<string, unknown>;
  return Boolean(clean(record.acceptedAt)) &&
    (record.smsConsent === true || record.stayNotificationsConsent === true);
}

function resolveLanguage(value: string | null): "es" | "en" {
  return clean(value).toLowerCase().startsWith("es") ? "es" : "en";
}

function deterministicMessageId(
  input: GuestAccessCommunicationOutboxInput,
  channel: GuestAccessCommunicationChannel,
  destination: string
): string {
  const digest = createHash("sha256")
    .update([
      "guest-access-passcode-v2",
      input.organizationId,
      input.propertyId,
      input.reservationId,
      input.accessGrantId,
      input.accessCodeHash,
      input.validFrom.toISOString(),
      input.validUntil.toISOString(),
      channel,
      destination,
    ].join("|"))
    .digest("hex")
    .slice(0, 40);
  return `gjcomm_${digest}`;
}

function emailBody(input: GuestAccessCommunicationOutboxInput): string {
  const reservationNumber = input.reservationNumber ?? "Pending";
  const guestLanguage = resolveLanguage(input.preferredLanguage);
  const subject = `${guestLanguage === "es" ? "Su acceso Pin&Go está listo - Reservación" : "Your Pin&Go access is ready - Reservation"} #${reservationNumber}`;
  return JSON.stringify({
    kind: "PIN_GO_EMAIL_DELIVERY",
    type: "GUEST_ACCESS_PASSCODE",
    subject,
    retryPayload: {
      reservationNumber,
      accessGrantId: input.accessGrantId,
      validFrom: input.validFrom.toISOString(),
      validUntil: input.validUntil.toISOString(),
      preferredLanguage: guestLanguage,
    },
  });
}

export function buildGuestAccessCommunicationOutbox(
  input: GuestAccessCommunicationOutboxInput
): PendingGuestAccessMessage[] {
  if (!clean(input.accessCodeHash)) return [];
  const rows: PendingGuestAccessMessage[] = [];
  const email = clean(input.guestEmail).toLowerCase();
  if (email) {
    rows.push({
      id: deterministicMessageId(input, "email", email),
      channel: "email",
      to: email,
      from: null,
      body: emailBody(input),
      provider: "resend",
      providerMessageId: null,
      status: "APMS_PENDING",
      accessGrantId: input.accessGrantId,
      error: null,
      retryCount: 0,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      communicationType: "GUEST_ACCESS_PASSCODE",
    });
  }

  const phone = clean(input.guestPhone);
  if (phone && hasGuestSmsConsent(input.externalRaw)) {
    rows.push({
      id: deterministicMessageId(input, "sms", phone),
      channel: "sms",
      to: phone,
      from: null,
      body: "APMS_GUEST_ACCESS_PASSCODE",
      provider: "twilio",
      providerMessageId: null,
      status: "APMS_PENDING",
      accessGrantId: input.accessGrantId,
      error: null,
      retryCount: 0,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      communicationType: "GUEST_ACCESS_PASSCODE",
    });
  }
  return rows;
}

function emailEnvelopeAccessGrantId(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.kind !== "PIN_GO_EMAIL_DELIVERY") return null;
    return clean(parsed?.retryPayload?.accessGrantId) || null;
  } catch {
    return null;
  }
}

function existingDeliveryGrantId(message: ExistingGuestAccessDeliveryEvidence): string | null {
  return clean(message.accessGrantId) ||
    (clean(message.channel).toLowerCase() === "email"
      ? emailEnvelopeAccessGrantId(message.body)
      : null);
}

const OWNED_DELIVERY_STATUSES = new Set([
  "APMS_PENDING",
  "E7_SENDING",
  "SENT",
  "FAILED",
  "FAILED_FINAL",
]);

export function filterAlreadyOwnedGuestAccessDeliveries(input: {
  rows: PendingGuestAccessMessage[];
  existing: ExistingGuestAccessDeliveryEvidence[];
  accessGrantId: string;
  accessGrantUpdatedAt: Date;
}): PendingGuestAccessMessage[] {
  return input.rows.filter((row) => {
    const destination = row.channel === "email" ? row.to.toLowerCase() : row.to;
    return !input.existing.some((message) => {
      if (!OWNED_DELIVERY_STATUSES.has(clean(message.status).toUpperCase())) return false;
      if (existingDeliveryGrantId(message) !== input.accessGrantId) return false;
      if (clean(message.channel).toLowerCase() !== row.channel) return false;
      const existingDestination = row.channel === "email"
        ? clean(message.to).toLowerCase()
        : clean(message.to);
      if (existingDestination !== destination) return false;
      return message.createdAt.getTime() >= input.accessGrantUpdatedAt.getTime();
    });
  });
}
