import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import {
  getGuestIntlLocale,
  resolveGuestLanguage,
  type GuestLanguage,
} from "./guest-language.service";

type SmsSendResult = {
  ok: boolean;
  sid?: string | null;
  status?: string | null;
  skipped?: boolean;
  error?: string | null;
};

type SendLoggedSmsArgs = {
  prisma: PrismaClient;
  to: string | null | undefined;
  body: string;
  accessGrantId?: string | null;

  reservationId?: string | null;
  propertyId?: string | null;
  organizationId?: string | null;

  provider?: "twilio";
  channel?: "sms";
  maskBodyForLog?: boolean;
  communicationType?: string | null;
};

type GuestPasscodeSmsArgs = {
  prisma: PrismaClient;
  reservationId: string;
  accessGrantId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  code?: string | null;
  validUntil: Date;
};

type CleaningSmsArgs = {
  prisma: PrismaClient;
  accessGrantId?: string | null;
  phoneE164?: string | null;
  staffName?: string | null;
  propertyName?: string | null;
  roomName?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone?: string | null;
  
  reservationId?: string | null;
  propertyId?: string | null;
  organizationId?: string | null;
};

function cleanEnv(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim();
  return v.length > 0 ? v : null;
}

function toGsmSafeText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/`/g, "'")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function toErrString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function getFromNumber(): string | null {
  return (
    cleanEnv(process.env.TWILIO_FROM_NUMBER) ??
    cleanEnv(process.env.TWILIO_SMS_FROM) ??
    cleanEnv(process.env.TWILIO_FROM)
  );
}

export function maskSensitiveBody(body: string): string {
  if (!body) return body;

  let masked = body;

  masked = masked.replace(
    /(código de entrada es:\s*)(\d{4,10})/gi,
    (_m, prefix, code) => {
      if (code.length <= 2) return `${prefix}**`;
      return `${prefix}${"*".repeat(Math.max(code.length - 2, 4))}${code.slice(-2)}`;
    }
  );

  masked = masked.replace(
    /(your access code is:\s*)(\d{4,10})/gi,
    (_m, prefix, code) => {
      if (code.length <= 2) return `${prefix}**`;
      return `${prefix}${"*".repeat(Math.max(code.length - 2, 4))}${code.slice(-2)}`;
    }
  );

  masked = masked.replace(
    /\b((?:Codigo|Code):\s*)(\d{4,10})\b/gi,
    (_m, prefix, code) => {
      if (code.length <= 2) return `${prefix}**`;
      return `${prefix}${"*".repeat(Math.max(code.length - 2, 4))}${code.slice(-2)}`;
    }
  );

  masked = masked.replace(
    /(https?:\/\/[^\s]*\/guest\/access\/)([A-Za-z0-9\-_]+)/gi,
    (_m, prefix, token) => `${prefix}${String(token).slice(0, 4)}****`
  );

  return masked;
}

function fmtWithTimezone(
  d: Date,
  timezone?: string,
  language: GuestLanguage = "en"
): string {
  return new Intl.DateTimeFormat(getGuestIntlLocale(language), {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(d));
}

export function buildGuestPasscodeSmsBody(params: {
  guestName?: string | null;
  code: string;
  validUntil: Date;
  timezone?: string;
  language: GuestLanguage;
}): string {
  const isSpanish = params.language === "es";
  const code = toGsmSafeText(params.code, 10);
  const validUntil = toGsmSafeText(
    fmtWithTimezone(
      params.validUntil,
      params.timezone,
      params.language
    ),
    32
  );

  if (isSpanish) {
    return `Pin&Go acceso. Codigo: ${code}. En keypad, ingresa el codigo y presiona desbloqueo (#, * o similar). Valido hasta ${validUntil}.`;
  }

  return `Pin&Go access. Code: ${code}. Enter code on keypad and press unlock (#, * or similar). Valid until ${validUntil}.`;
}

export function buildCleaningStartSmsBody(params: {
  staffName?: string | null;
  propertyName?: string | null;
  roomName?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone?: string | null;
}): string {
  return (
    `Pin&Go - Limpieza INICIADA\n` +
    `Asignado: ${cleanEnv(params.staffName) ?? "Staff"}\n` +
    `Propiedad: ${cleanEnv(params.propertyName) ?? "N/A"}\n` +
    `Unidad: ${cleanEnv(params.roomName) ?? "N/A"}\n` +
    `Inicio: ${fmtWithTimezone(
      params.startsAt,
      params.timezone ?? "America/Puerto_Rico",
      "es"
      )}\n` +
     `Fin: ${fmtWithTimezone(
       params.endsAt,
       params.timezone ?? "America/Puerto_Rico",
       "es"
     )}\n` +
    `Su tarjeta NFC esta activa unicamente durante esta ventana.`
  );
}

export function buildCleaningEndSmsBody(params: {
  staffName?: string | null;
  propertyName?: string | null;
  roomName?: string | null;
  endsAt: Date;
  timezone?: string | null;
}): string {
  const propertyName =
    toGsmSafeText(cleanEnv(params.propertyName) ?? "N/A", 24) || "N/A";
  const roomName =
    toGsmSafeText(cleanEnv(params.roomName) ?? "N/A", 16) || "N/A";
  const end = toGsmSafeText(
    fmtWithTimezone(
      params.endsAt,
      params.timezone ?? "America/Puerto_Rico",
      "en"
    ),
    24
  );

  return (
    `Pin&Go cleaning done/lista. ` +
    `Prop: ${propertyName}. ` +
    `Unit/Unidad: ${roomName}. ` +
    `End/Fin: ${end}. ` +
    `Access/Acceso ended/finalizado.`
  );
}

export async function sendLoggedSms(args: SendLoggedSmsArgs): Promise<SmsSendResult> {
  const {
    prisma,
    to,
    body,
    accessGrantId = null,
    reservationId = null,
    propertyId = null,
    organizationId = null,
    provider = "twilio",
    channel = "sms",
    maskBodyForLog = false,
    communicationType = null,
  } = args;

  const phone = cleanEnv(to);
  if (!phone) {
    return {
      ok: false,
      skipped: true,
      error: "Missing destination phone",
    };
  }

  const bodyForLog = maskBodyForLog ? maskSensitiveBody(body) : body;

  try {
    const sent = (await sendSms(phone, body)) as any;

    await prisma.messageLog.create({
      data: {
        channel,
        to: phone,
        from: getFromNumber(),
        body: bodyForLog,
        provider,
        providerMessageId: sent?.sid ?? null,
        status: "SENT",
        accessGrantId,
        reservationId,
        propertyId,
        organizationId,
        communicationType,
      },
    });

    return {
      ok: true,
      sid: sent?.sid ?? null,
      status: "SENT",
      error: null,
    };
  } catch (e) {
    const error = toErrString(e);

    try {
      await prisma.messageLog.create({
        data: {
          channel,
          to: phone,
          from: getFromNumber(),
          body: bodyForLog,
          provider,
          providerMessageId: null,
          status: "FAILED",
          accessGrantId,
          error,
          reservationId,
          propertyId,
          organizationId,
          communicationType,
        },
      });
    } catch {
      // no bloquear flujo
    }

    return {
      ok: false,
      sid: null,
      status: "FAILED",
      error,
    };
  }
}

export async function sendGuestPasscodeSms(
  args: GuestPasscodeSmsArgs
): Promise<SmsSendResult> {
  const {
    prisma,
    reservationId,
    accessGrantId = null,
    guestName,
    guestPhone,
    code,
    validUntil,
  } = args;

  if (!cleanEnv(guestPhone)) {
    return {
      ok: false,
      skipped: true,
      error: `Reservation ${reservationId} has no guestPhone`,
    };
  }

  if (!cleanEnv(code)) {
    return {
      ok: false,
      skipped: true,
      error: `Reservation ${reservationId} has no passcode`,
    };
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      preferredLanguage: true,
      property: {
        select: {
          timezone: true,
        },
      },
    },
  });

  const language = resolveGuestLanguage(reservation?.preferredLanguage);

  const body = buildGuestPasscodeSmsBody({
    ...(guestName !== undefined ? { guestName } : {}),
    code: String(code),
    validUntil,
    ...(reservation?.property?.timezone
      ? { timezone: reservation.property.timezone }
      : {}),
    language,
  });

  return sendLoggedSms({
    prisma,
    to: guestPhone,
    body,
    accessGrantId,
    reservationId,
    provider: "twilio",
    channel: "sms",
    maskBodyForLog: true,
    communicationType: "GUEST_ACCESS_PASSCODE",
  });
}

export async function sendCleaningStartSms(
  args: CleaningSmsArgs
): Promise<SmsSendResult> {
  const body = buildCleaningStartSmsBody({
    staffName: args.staffName,
    propertyName: args.propertyName,
    roomName: args.roomName,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    timezone: args.timezone,
 });

  return sendLoggedSms({
    prisma: args.prisma,
    to: args.phoneE164,
    body,
    accessGrantId: args.accessGrantId ?? null,
    reservationId: args.reservationId ?? null,
    propertyId: args.propertyId ?? null,
    organizationId: args.organizationId ?? null,
    provider: "twilio",
    channel: "sms",
    maskBodyForLog: false,
  });
}

export async function sendCleaningEndSms(
  args: Omit<CleaningSmsArgs, "startsAt"> & { endsAt: Date }
): Promise<SmsSendResult> {
  const body = buildCleaningEndSmsBody({
    staffName: args.staffName,
    propertyName: args.propertyName,
    roomName: args.roomName,
    endsAt: args.endsAt,
    timezone: args.timezone,
  });

  return sendLoggedSms({
    prisma: args.prisma,
    to: args.phoneE164,
    body,
    accessGrantId: args.accessGrantId ?? null,
    reservationId: args.reservationId ?? null,
    propertyId: args.propertyId ?? null,
    organizationId: args.organizationId ?? null,
    provider: "twilio",
    channel: "sms",
    maskBodyForLog: false,
  });
}
