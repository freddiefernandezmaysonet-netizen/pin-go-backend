import { Resend } from "resend";
import { normalizeMfaEmail } from "./mfa-email-only-policy.js";

export type MfaEmailDeliveryMode = "MOCK" | "RESEND";

export type MfaEmailDeliveryEnvironment = {
  PINGO_MFA_EMAIL_DELIVERY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

export type MfaEmailSender = (input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}) => Promise<{ providerMessageId: string | null }>;

export type MfaEmailDeliveryResult = {
  delivered: boolean;
  mode: MfaEmailDeliveryMode;
  providerMessageId: string | null;
};

export function resolveMfaEmailDeliveryMode(
  env: MfaEmailDeliveryEnvironment = process.env
): MfaEmailDeliveryMode {
  return String(env.PINGO_MFA_EMAIL_DELIVERY ?? "")
    .trim()
    .toUpperCase() === "RESEND"
    ? "RESEND"
    : "MOCK";
}

async function defaultResendSender(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<{ providerMessageId: string | null }> {
  const resend = new Resend(input.apiKey);
  const { data, error } = await resend.emails.send({
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });

  if (error) {
    throw new Error(`MFA_EMAIL_RESEND_FAILED:${error.name}`);
  }

  return { providerMessageId: data?.id ?? null };
}

export async function deliverMfaEmailOtp(
  input: {
    destination: string;
    code: string;
    expiresInMinutes: number;
  },
  options: {
    env?: MfaEmailDeliveryEnvironment;
    sender?: MfaEmailSender;
  } = {}
): Promise<MfaEmailDeliveryResult> {
  const env = options.env ?? process.env;
  const mode = resolveMfaEmailDeliveryMode(env);

  if (mode === "MOCK") {
    return { delivered: false, mode, providerMessageId: null };
  }

  const destination = normalizeMfaEmail(input.destination);
  const code = String(input.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("MFA_EMAIL_OTP_INVALID");
  if (input.expiresInMinutes !== 5) throw new Error("MFA_EMAIL_OTP_TTL_INVALID");

  const apiKey = String(env.RESEND_API_KEY ?? "").trim();
  const from = String(env.EMAIL_FROM ?? "").trim();
  if (!apiKey || !from) throw new Error("MFA_EMAIL_DELIVERY_CONFIG_MISSING");

  const sender = options.sender ?? defaultResendSender;
  const result = await sender({
    apiKey,
    from,
    to: destination,
    subject: "Tu código de seguridad de Pin&Go / Your Pin&Go security code",
    html: `<div style="font-family:Arial,sans-serif;color:#173d31;line-height:1.6;max-width:560px;margin:auto">
      <h2>Pin&Go Security</h2>
      <p>Tu código de seguridad es / Your security code is:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${code}</p>
      <p>Expira en 5 minutos. No compartas este código.<br/>Expires in 5 minutes. Do not share this code.</p>
      <p style="color:#52665d;font-size:13px">Si no intentaste iniciar sesión, puedes ignorar este correo.<br/>If you did not try to sign in, you can ignore this email.</p>
    </div>`,
  });

  return {
    delivered: true,
    mode,
    providerMessageId: result.providerMessageId,
  };
}
