import type { PrismaClient } from "@prisma/client";

export type MessageDeliveryProvider = "resend" | "twilio";

export type ProviderDeliveryStatus =
  | "ACCEPTED"
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERY_DELAYED"
  | "DELIVERED"
  | "READ"
  | "UNDELIVERED"
  | "FAILED"
  | "BOUNCED"
  | "SUPPRESSED"
  | "COMPLAINED"
  | "CANCELED";

export type ProviderDeliveryOutcome = {
  provider: MessageDeliveryProvider;
  providerMessageId: string;
  status: ProviderDeliveryStatus;
  eventAt: Date;
  deliveredAt?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

const STATUS_RANK: Record<ProviderDeliveryStatus, number> = {
  ACCEPTED: 10,
  QUEUED: 11,
  SENDING: 12,
  SENT: 20,
  DELIVERY_DELAYED: 21,
  DELIVERED: 30,
  READ: 35,
  UNDELIVERED: 40,
  FAILED: 40,
  BOUNCED: 40,
  SUPPRESSED: 40,
  CANCELED: 40,
  COMPLAINED: 50,
};

const TERMINAL_STATUSES = new Set<ProviderDeliveryStatus>([
  "DELIVERED",
  "READ",
  "UNDELIVERED",
  "FAILED",
  "BOUNCED",
  "SUPPRESSED",
  "COMPLAINED",
  "CANCELED",
]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function safeDate(value: unknown, fallback = new Date()): Date {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function summarize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim().slice(0, 500) || null;
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

export function shouldApplyProviderDeliveryTransition(
  current: string | null | undefined,
  next: ProviderDeliveryStatus
): boolean {
  const normalizedCurrent = clean(current).toUpperCase() as ProviderDeliveryStatus;

  if (!normalizedCurrent) return true;
  if (!(normalizedCurrent in STATUS_RANK)) return true;
  if (normalizedCurrent === next) return true;

  if (normalizedCurrent === "COMPLAINED") return false;

  const currentTerminal = TERMINAL_STATUSES.has(normalizedCurrent);
  const nextTerminal = TERMINAL_STATUSES.has(next);

  if (currentTerminal && !nextTerminal) return false;

  return STATUS_RANK[next] >= STATUS_RANK[normalizedCurrent];
}

export function normalizeResendDeliveryEvent(
  event: any,
  now = new Date()
): ProviderDeliveryOutcome | null {
  const type = clean(event?.type).toLowerCase();
  const providerMessageId =
    clean(event?.data?.email_id) ||
    clean(event?.data?.id);

  if (!providerMessageId) return null;

  const statusByType: Record<string, ProviderDeliveryStatus> = {
    "email.sent": "SENT",
    "email.delivered": "DELIVERED",
    "email.delivery_delayed": "DELIVERY_DELAYED",
    "email.bounced": "BOUNCED",
    "email.complained": "COMPLAINED",
    "email.failed": "FAILED",
    "email.suppressed": "SUPPRESSED",
  };

  const status = statusByType[type];
  if (!status) return null;

  const eventAt = safeDate(event?.created_at ?? event?.data?.created_at, now);
  const bounceMessage =
    event?.data?.bounce?.message ??
    event?.data?.error ??
    event?.data?.reason ??
    null;

  return {
    provider: "resend",
    providerMessageId,
    status,
    eventAt,
    deliveredAt: status === "DELIVERED" ? eventAt : null,
    errorCode:
      status === "BOUNCED"
        ? clean(event?.data?.bounce?.type) || null
        : null,
    errorMessage:
      ["BOUNCED", "FAILED", "SUPPRESSED", "COMPLAINED"].includes(status)
        ? summarize(bounceMessage ?? type)
        : null,
  };
}

export function normalizeTwilioDeliveryCallback(
  params: Record<string, unknown>,
  now = new Date()
): ProviderDeliveryOutcome | null {
  const providerMessageId =
    clean(params.MessageSid) ||
    clean(params.SmsSid) ||
    clean(params.SmsMessageSid);

  if (!providerMessageId) return null;

  const rawStatus =
    clean(params.MessageStatus || params.SmsStatus).toLowerCase();

  const statusByProvider: Record<string, ProviderDeliveryStatus> = {
    accepted: "ACCEPTED",
    queued: "QUEUED",
    sending: "SENDING",
    sent: "SENT",
    delivered: "DELIVERED",
    read: "READ",
    undelivered: "UNDELIVERED",
    failed: "FAILED",
    canceled: "CANCELED",
  };

  const status = statusByProvider[rawStatus];
  if (!status) return null;

  return {
    provider: "twilio",
    providerMessageId,
    status,
    eventAt: now,
    deliveredAt:
      status === "DELIVERED" || status === "READ"
        ? now
        : null,
    errorCode: clean(params.ErrorCode) || null,
    errorMessage: clean(params.ErrorMessage) || null,
  };
}

export async function recordMessageDeliveryOutcome(
  prisma: PrismaClient,
  outcome: ProviderDeliveryOutcome
) {
  const existing = await prisma.messageLog.findFirst({
    where: {
      provider: outcome.provider,
      providerMessageId: outcome.providerMessageId,
    },
    select: {
      id: true,
      providerDeliveryStatus: true,
      deliveredAt: true,
    },
  });

  if (!existing) {
    return {
      matched: false,
      applied: false,
      messageLogId: null as string | null,
    };
  }

  if (
    !shouldApplyProviderDeliveryTransition(
      existing.providerDeliveryStatus,
      outcome.status
    )
  ) {
    return {
      matched: true,
      applied: false,
      messageLogId: existing.id,
    };
  }

  const successful =
    outcome.status === "DELIVERED" ||
    outcome.status === "READ";

  await prisma.messageLog.update({
    where: {
      id: existing.id,
    },
    data: {
      providerDeliveryStatus: outcome.status,
      providerStatusUpdatedAt: outcome.eventAt,
      providerErrorCode: successful
        ? null
        : outcome.errorCode ?? null,
      providerErrorMessage: successful
        ? null
        : outcome.errorMessage ?? null,
      ...(outcome.deliveredAt && !existing.deliveredAt
        ? { deliveredAt: outcome.deliveredAt }
        : {}),
    },
  });

  return {
    matched: true,
    applied: true,
    messageLogId: existing.id,
  };
}
