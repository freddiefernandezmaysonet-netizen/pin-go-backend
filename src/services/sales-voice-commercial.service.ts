import type { PrismaClient, SalesProspect, SalesVoiceCall } from "@prisma/client";

// Internal service only. No public route, SIP listener, provider callbacks,
// automatic messaging, customer account access or payments are implemented here.
// Every future telephony entry point MUST verify its provider signature first.
type Db = Pick<PrismaClient, "$transaction" | "salesProspect" | "salesVoiceCall">;
type Language = "es" | "en";
type Outcome =
  | "INFORMATION_PROVIDED"
  | "SIGNUP_LINK_SHARED"
  | "DEMO_REQUESTED"
  | "NO_INTEREST"
  | "HANDOFF_REQUESTED"
  | "CALL_DROPPED";
type FollowUpChannel = "EMAIL" | "SMS";
type FollowUpPurpose = "REQUESTED_INFORMATION" | "MARKETING";

export class SalesVoiceCommercialError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SalesVoiceCommercialError";
  }
}

function reject(code: string): never {
  throw new SalesVoiceCommercialError(code);
}

function normalizePhone(raw: string | null | undefined, required = false): string | null {
  const value = raw?.trim() || null;
  if (!value) return required ? reject("PHONE_REQUIRED") : null;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) reject("INVALID_PHONE");
  return value;
}

function normalizeEmail(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase() || null;
  if (!value) return null;
  if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) reject("INVALID_EMAIL");
  return value;
}

function optionalText(raw: string | null | undefined, max: number): string | null {
  const value = raw?.trim() || null;
  if (value && value.length > max) reject("INVALID_TEXT_LENGTH");
  return value;
}

function requireSid(value: string): string {
  // Twilio Call SIDs are not authentication: signature verification is external.
  if (!/^CA[0-9a-fA-F]{32}$/.test(value)) reject("INVALID_TWILIO_CALL_SID");
  return value;
}

function prismaUnique(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "P2002";
}

function assertSameCall(call: SalesVoiceCall, input: {
  providerCallId: string;
  fromPhoneE164: string | null;
  toPhoneE164: string;
}): SalesVoiceCall {
  if (call.provider !== "TWILIO" || call.direction !== "INBOUND"
    || call.providerCallId !== input.providerCallId
    || call.fromPhoneE164 !== input.fromPhoneE164
    || call.toPhoneE164 !== input.toPhoneE164) {
    reject("PROVIDER_CALL_ID_CONFLICT");
  }
  return call;
}

export class SalesVoiceCommercialService {
  constructor(private readonly db: Db) {}

  async recordInboundCall(input: {
    providerCallId: string;
    fromPhoneE164?: string | null;
    toPhoneE164: string;
  }): Promise<SalesVoiceCall> {
    const payload = {
      providerCallId: requireSid(input.providerCallId),
      fromPhoneE164: normalizePhone(input.fromPhoneE164),
      toPhoneE164: normalizePhone(input.toPhoneE164, true)!,
    };
    try {
      return await this.db.salesVoiceCall.create({
        data: { ...payload, provider: "TWILIO", direction: "INBOUND", status: "RECEIVED" },
      });
    } catch (error) {
      if (!prismaUnique(error)) throw error;
      const existing = await this.db.salesVoiceCall.findUnique({
        where: { providerCallId: payload.providerCallId },
      });
      if (!existing) throw error;
      return assertSameCall(existing, payload);
    }
  }

  async createProspectFromCall(input: {
    providerCallId: string;
    fullName?: string | null;
    email?: string | null;
    phoneE164?: string | null;
    organizationName?: string | null;
    propertyCount?: number | null;
    preferredLanguage?: Language | null;
  }): Promise<SalesProspect> {
    const providerCallId = requireSid(input.providerCallId);
    const fullName = optionalText(input.fullName, 200);
    const email = normalizeEmail(input.email);
    const phoneE164 = normalizePhone(input.phoneE164);
    const organizationName = optionalText(input.organizationName, 200);
    if (!fullName && !email) reject("PROSPECT_IDENTITY_REQUIRED");
    if (input.propertyCount != null &&
      (!Number.isSafeInteger(input.propertyCount) || input.propertyCount < 0 || input.propertyCount > 100000)) {
      reject("INVALID_PROPERTY_COUNT");
    }
    if (input.preferredLanguage != null && input.preferredLanguage !== "es"
      && input.preferredLanguage !== "en") reject("INVALID_LANGUAGE");

    const data = {
      fullName, email, phoneE164, organizationName,
      propertyCount: input.propertyCount ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      source: "PHONE",
      status: "NEW",
      // An inbound call or a spoken sales conversation never implies marketing consent.
    };

    try {
      return await this.db.$transaction(async tx => {
        const call = await tx.salesVoiceCall.findUnique({ where: { providerCallId } });
        if (!call || call.provider !== "TWILIO" || call.direction !== "INBOUND") {
          return reject("CALL_NOT_FOUND");
        }
        if (call.prospectId) {
          const previous = await tx.salesProspect.findUnique({ where: { id: call.prospectId } });
          if (!previous) return reject("PROSPECT_NOT_FOUND");
          return previous;
        }
        const prospect = await tx.salesProspect.create({ data });
        const changed = await tx.salesVoiceCall.updateMany({
          where: { id: call.id, prospectId: null },
          data: { prospectId: prospect.id },
        });
        // If a concurrent transaction linked the call, rollback this new prospect.
        if (changed.count !== 1) return reject("CALL_LINK_RACE");
        return prospect;
      });
    } catch (error) {
      if (!(error instanceof SalesVoiceCommercialError) || error.code !== "CALL_LINK_RACE") {
        throw error;
      }
      const call = await this.db.salesVoiceCall.findUnique({ where: { providerCallId } });
      if (!call?.prospectId) throw error;
      const prospect = await this.db.salesProspect.findUnique({ where: { id: call.prospectId } });
      if (!prospect) return reject("PROSPECT_NOT_FOUND");
      return prospect;
    }
  }

  async completeCall(input: {
    providerCallId: string;
    disposition: Outcome;
    endedAt?: Date;
  }): Promise<SalesVoiceCall> {
    const providerCallId = requireSid(input.providerCallId);
    const permitted: Outcome[] = [
      "INFORMATION_PROVIDED", "SIGNUP_LINK_SHARED", "DEMO_REQUESTED",
      "NO_INTEREST", "HANDOFF_REQUESTED", "CALL_DROPPED",
    ];
    if (!permitted.includes(input.disposition)) reject("INVALID_DISPOSITION");
    const call = await this.db.salesVoiceCall.findUnique({ where: { providerCallId } });
    if (!call) reject("CALL_NOT_FOUND");
    if (call.endedAt) return call;

    const endedAt = input.endedAt ?? new Date();
    if (!Number.isFinite(endedAt.getTime()) || endedAt.getTime() < call.startedAt.getTime()) {
      reject("INVALID_END_TIME");
    }
    const durationSeconds = Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000);
    await this.db.salesVoiceCall.updateMany({
      where: { id: call.id, endedAt: null },
      data: { status: "COMPLETED", disposition: input.disposition, endedAt, durationSeconds },
    });
    // The previously persisted outcome wins if two final callbacks race.
    return this.db.salesVoiceCall.findUniqueOrThrow({ where: { id: call.id } });
  }

  async prepareSignupHandoff(prospectId: string): Promise<{
    url: string; status: "CUSTOMER_ACTION_REQUIRED";
  }> {
    const prospect = await this.db.salesProspect.findUnique({ where: { id: prospectId } });
    if (!prospect) reject("PROSPECT_NOT_FOUND");
    if (prospect.convertedAt || prospect.convertedOrganizationId) reject("ALREADY_CONVERTED");
    // No PII, auto-login credential, payment token or caller ID in this URL.
    return { url: "https://pin-ngo.com", status: "CUSTOMER_ACTION_REQUIRED" };
  }

  async prepareFollowUp(input: {
    prospectId: string;
    channel: FollowUpChannel;
    purpose: FollowUpPurpose;
  }): Promise<{
    status: "READY_FOR_MANUAL_REVIEW";
    channel: FollowUpChannel;
    purpose: FollowUpPurpose;
    recipient: string;
  }> {
    const prospect = await this.db.salesProspect.findUnique({ where: { id: input.prospectId } });
    if (!prospect) reject("PROSPECT_NOT_FOUND");
    if (prospect.convertedAt || prospect.convertedOrganizationId) reject("ALREADY_CONVERTED");
    if (!["EMAIL", "SMS"].includes(input.channel)) reject("INVALID_CHANNEL");
    if (!["REQUESTED_INFORMATION", "MARKETING"].includes(input.purpose)) reject("INVALID_PURPOSE");
    if (!prospect.contactConsentAt) reject("CONTACT_CONSENT_REQUIRED");
    if (input.purpose === "MARKETING" && !prospect.marketingConsentAt) {
      reject("MARKETING_CONSENT_REQUIRED");
    }
    const recipient = input.channel === "EMAIL"
      ? normalizeEmail(prospect.email)
      : normalizePhone(prospect.phoneE164);
    if (!recipient) reject("RECIPIENT_REQUIRED");
    // No sending, queue, timer or provider credentials; human review is still required.
    return {
      status: "READY_FOR_MANUAL_REVIEW",
      channel: input.channel,
      purpose: input.purpose,
      recipient,
    };
  }
}
