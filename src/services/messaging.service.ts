import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

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

  // ✅ NUEVO (multi-tenant tracing)
  reservationId?: string | null;
  propertyId?: string | null;
  organizationId?: string | null;

  provider?: "twilio";
  channel?: "sms";
  maskBodyForLog?: boolean;
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

  // ✅ NUEVO (opcional)
  reservationId?: string | null;
  propertyId?: string | null;
  organizationId?: string | null;
};

function cleanEnv(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim();
  return v.length > 0 ? v : null;
}

function toErrString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function fmtUtc(d: Date): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function getFromNumber(): string | null {
  return (
    cleanEnv(process.env.TWILIO_FROM_NUMBER) ??
    cleanEnv(process.env.TWILIO_SMS_FROM) ??
    cleanEnv(process.env.TWILIO_FROM)
  );
}

function maskSensitiveBody(body: string): string {
  if (!body) return body;

  let masked = body;

  // 🔐 Enmascarar código de acceso en español
  masked = masked.replace(
    /(código de entrada es:\s*)(\d{4,10})/gi,
    (_m, prefix, code) => {
      if (code.length <= 2) return `${prefix}**`;
      return `${prefix}${"*".repeat(Math.max(code.length - 2, 4))}${code.slice(-2)}`;
    }
  );

  // 🔐 Enmascarar código de acceso en inglés
  masked = masked.replace(
    /(your access code is:\s*)(\d{4,10})/gi,
    (_m, prefix, code) => {
      if (code.length <= 2) return `${prefix}**`;
      return `${prefix}${"*".repeat(Math.max(code.length - 2, 4))}${code.slice(-2)}`;
    }
  );

  // 🔐 Enmascarar guest link token
  masked = masked.replace(
    /(https?:\/\/[^\s]*\/guest\/access\/)([A-Za-z0-9\-_]+)/gi,
    (_m, prefix, token) => `${prefix}${String(token).slice(0, 4)}****`
  );

  return masked;
}

export function buildGuestPasscodeSmsBody(params: {
  guestName?: string | null;
  code: string;
  validUntil: Date;
}): string {
  const guestName = params.guestName ?? "Guest";
  const validUntil = new Date(params.validUntil).toLocaleString();

  const es = `🔐 Pin&Go Access

Hola ${guestName},

Tu código de entrada es:
${params.code}

⚠️ IMPORTANTE:
- Ingresa el código en el keypad
- Presiona la tecla de desbloqueo (#, *, u otro símbolo según el modelo)

🕒 Válido hasta:
${validUntil}

Durante tu estadía, el acceso continuo estará disponible mediante tarjetas NFC.

— Pin&Go`;

  const en = `🔐 Pin&Go Access

Hi ${guestName},

Your access code is:
${params.code}

⚠️ IMPORTANT:
- Enter the code on the keypad
- Press the unlock key (#, *, or another symbol depending on the model)

🕒 Valid until:
${validUntil}

During your stay, continuous access may be available via NFC cards.

— Pin&Go`;

  return `${es}

---

${en}`;
}

export function buildCleaningEndSmsBody(params: {
  staffName?: string | null;
  propertyName?: string | null;
  roomName?: string | null;
  endsAt: Date;
}): string {
  return (
    `Pin&Go ✅ Limpieza FINALIZADA\n` +
    `Asignado: ${cleanEnv(params.staffName) ?? "Staff"}\n` +
    `Propiedad: ${cleanEnv(params.propertyName) ?? "N/A"}\n` +
    `Unidad: ${cleanEnv(params.roomName) ?? "N/A"}\n` +
    `Fin: ${fmtUtc(params.endsAt)}\n` +
    `Acceso expiró automáticamente.`
  );
}

export async function sendLoggedSms(args: SendLoggedSmsArgs): Promise<SmsSendResult> {
  const {
    prisma,
    to,
    body,
    accessGrantId = null,

    // ✅ NUEVO
    reservationId = null,
    propertyId = null,
    organizationId = null,

    provider = "twilio",
    channel = "sms",
    maskBodyForLog = false,
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

        // ✅ NUEVO (multi-tenant)
        reservationId,
        propertyId,
        organizationId,
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

          // ✅ NUEVO
          reservationId,
          propertyId,
          organizationId,
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

  const body = buildGuestPasscodeSmsBody({
    guestName,
    code: String(code),
    validUntil,
  });

  return sendLoggedSms({
    prisma,
    to: guestPhone,
    body,
    accessGrantId,
    reservationId, // ✅ YA LO TENEMOS
    provider: "twilio",
    channel: "sms",
    maskBodyForLog: true,
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
  });

  return sendLoggedSms({
    prisma: args.prisma,
    to: args.phoneE164,
    body,
    accessGrantId: args.accessGrantId ?? null,

    // ✅ NUEVO (si vienen)
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
  });

  return sendLoggedSms({
    prisma: args.prisma,
    to: args.phoneE164,
    body,
    accessGrantId: args.accessGrantId ?? null,

    // ✅ NUEVO
    reservationId: args.reservationId ?? null,
    propertyId: args.propertyId ?? null,
    organizationId: args.organizationId ?? null,

    provider: "twilio",
    channel: "sms",
    maskBodyForLog: false,
  });
}