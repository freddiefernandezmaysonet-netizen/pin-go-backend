import type { PrismaClient } from "@prisma/client";

export type LoggedEmailMessageType =
  | "DIRECT_BOOKING_GUEST_CONFIRMATION"
  | "DIRECT_BOOKING_HOST_NOTIFICATION"
  | "MANUAL_RESERVATION_GUEST_CONFIRMATION"
  | "MANUAL_RESERVATION_GUEST_CANCELLATION"
  | "DIRECT_BOOKING_GUEST_CANCELLATION"
  | "DIRECT_BOOKING_HOST_CANCELLATION"
  | "GUEST_ACCESS_PASSCODE"
  | "GUEST_VERIFICATION_REMINDER";

type SendLoggedEmailResult = {
  ok: boolean;
  skipped?: boolean;
  status: "SENT" | "FAILED" | "SKIPPED";
  providerMessageId?: string | null;
  error?: string | null;
};

type SendLoggedEmailArgs = {
  prisma: PrismaClient;

  type: LoggedEmailMessageType;
  to: string | null | undefined;
  subject: string;

  reservationId: string;
  propertyId?: string | null;
  organizationId?: string | null;

  retryPayload?: Record<string, unknown>;

  send: () => Promise<unknown>;
};

function cleanValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function toErrString(error: unknown) {
  const anyError = error as any;

  if (error instanceof Error) {
    const code = anyError?.code ? ` code=${anyError.code}` : "";
    const status = anyError?.status ? ` status=${anyError.status}` : "";

    return `${error.name}: ${error.message}${code}${status}`;
  }

  return String(error);
}

function getProviderMessageId(result: unknown) {
  const anyResult = result as any;

  return (
    anyResult?.data?.id ??
    anyResult?.id ??
    anyResult?.messageId ??
    anyResult?.providerMessageId ??
    null
  );
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, childValue] of Object.entries(value)) {
      if (childValue !== undefined) {
        output[key] = toJsonSafe(childValue);
      }
    }

    return output;
  }

  return value;
}

function buildEmailLogBody(input: {
  type: LoggedEmailMessageType;
  subject: string;
  retryPayload?: Record<string, unknown>;
}) {
  return JSON.stringify({
    kind: "PIN_GO_EMAIL_DELIVERY",
    type: input.type,
    subject: input.subject,
    retryPayload: toJsonSafe(input.retryPayload ?? {}),
  });
}

async function createDispatchLogSafe(args: {
  prisma: PrismaClient;
  reservationId: string;
  type: LoggedEmailMessageType;
  channel: string;
  status: string;
}) {
  try {
    await args.prisma.messageDispatchLog.create({
      data: {
        reservationId: args.reservationId,
        type: args.type,
        channel: args.channel,
        status: args.status,
      },
    });
  } catch (error) {
    console.error("[EMAIL_DELIVERY_DISPATCH_LOG_ERROR]", {
      reservationId: args.reservationId,
      type: args.type,
      status: args.status,
      error: toErrString(error),
    });
  }
}

async function createMessageLogSafe(args: {
  prisma: PrismaClient;
  type: LoggedEmailMessageType;
  to: string;
  subject: string;
  status: "SENT" | "FAILED";
  providerMessageId?: string | null;
  error?: string | null;
  reservationId: string;
  propertyId?: string | null;
  organizationId?: string | null;
  retryPayload?: Record<string, unknown>;
}) {
  try {
    await args.prisma.messageLog.create({
      data: {
        channel: "email",
        to: args.to,
        from: null,
        body: buildEmailLogBody({
          type: args.type,
          subject: args.subject,
          retryPayload: args.retryPayload,
        }),
        provider: "resend",
        providerMessageId: args.providerMessageId ?? null,
        status: args.status,
        error: args.error ?? null,
        reservationId: args.reservationId,
        propertyId: args.propertyId ?? null,
        organizationId: args.organizationId ?? null,
      },
    });
  } catch (error) {
    console.error("[EMAIL_DELIVERY_MESSAGE_LOG_ERROR]", {
      reservationId: args.reservationId,
      type: args.type,
      status: args.status,
      error: toErrString(error),
    });
  }
}

export async function sendLoggedEmail(
  args: SendLoggedEmailArgs
): Promise<SendLoggedEmailResult> {
  const to = cleanValue(args.to);

  if (!to) {
    await createDispatchLogSafe({
      prisma: args.prisma,
      reservationId: args.reservationId,
      type: args.type,
      channel: "email",
      status: "SKIPPED",
    });

    return {
      ok: false,
      skipped: true,
      status: "SKIPPED",
      error: "Missing destination email",
    };
  }

  try {
    const result = await args.send();
    const providerMessageId = getProviderMessageId(result);

    await createMessageLogSafe({
      prisma: args.prisma,
      type: args.type,
      to,
      subject: args.subject,
      status: "SENT",
      providerMessageId,
      reservationId: args.reservationId,
      propertyId: args.propertyId ?? null,
      organizationId: args.organizationId ?? null,
      retryPayload: args.retryPayload,
    });

    await createDispatchLogSafe({
      prisma: args.prisma,
      reservationId: args.reservationId,
      type: args.type,
      channel: "email",
      status: "SENT",
    });

    return {
      ok: true,
      status: "SENT",
      providerMessageId,
      error: null,
    };
  } catch (error) {
    const errorMessage = toErrString(error);

    await createMessageLogSafe({
      prisma: args.prisma,
      type: args.type,
      to,
      subject: args.subject,
      status: "FAILED",
      providerMessageId: null,
      error: errorMessage,
      reservationId: args.reservationId,
      propertyId: args.propertyId ?? null,
      organizationId: args.organizationId ?? null,
      retryPayload: args.retryPayload,
    });

    await createDispatchLogSafe({
      prisma: args.prisma,
      reservationId: args.reservationId,
      type: args.type,
      channel: "email",
      status: "FAILED",
    });

    return {
      ok: false,
      status: "FAILED",
      providerMessageId: null,
      error: errorMessage,
    };
  }
}