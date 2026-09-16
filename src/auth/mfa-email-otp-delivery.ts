import { Resend } from "resend";
import { normalizeMfaEmail } from "./mfa-email-only-policy.js";

export type MfaEmailDeliveryMode = "MOCK" | "RESEND";

export type MfaEmailDeliveryEnvironment = {
  PINGO_MFA_EMAIL_DELIVERY?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
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

function readProcessMfaEmailEnvironment(): MfaEmailDeliveryEnvironment {
  return {
    PINGO_MFA_EMAIL_DELIVERY: process.env.PINGO_MFA_EMAIL_DELIVERY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
}

export function resolveMfaEmailDeliveryMode(
  env: MfaEmailDeliveryEnvironment = readProcessMfaEmailEnvironment()
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

function renderMfaEmailHtml(code: string): string {
  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
          PIN&amp;GO SECURITY
        </p>

        <h1 style="margin:0;font-size:28px;line-height:1.15;">
          C&oacute;digo de verificaci&oacute;n / Verification code
        </h1>

        <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
          Inicio de sesi&oacute;n seguro / Secure sign-in
        </p>
      </div>

      <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:16px;padding:22px;margin:22px 0;text-align:center;">
        <p style="margin:0 0 8px;color:#475569;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
          C&Oacute;DIGO DE SEGURIDAD / SECURITY CODE
        </p>

        <p style="margin:0;font-size:36px;font-weight:800;letter-spacing:0.18em;color:#2563eb;">
          ${code}
        </p>
      </div>

      <div lang="es" style="margin:24px 0;">
        <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">
          ESPA&Ntilde;OL
        </p>

        <h2 style="margin:0 0 10px;color:#111827;font-size:22px;">
          Confirma tu inicio de sesi&oacute;n
        </h2>

        <p style="margin:0 0 14px;color:#374151;">
          Usa el c&oacute;digo de seguridad de arriba para completar tu inicio de sesi&oacute;n en Pin&amp;Go.
        </p>

        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:16px;margin:16px 0;">
          <p style="margin:0;color:#1e40af;">
            <strong>Expira en 5 minutos.</strong> Este c&oacute;digo es personal y de un solo uso. No lo compartas con nadie.
          </p>
        </div>

        <p style="margin:0;color:#475569;font-size:13px;">
          Si no intentaste iniciar sesi&oacute;n, puedes ignorar este correo. Pin&amp;Go nunca te pedir&aacute; este c&oacute;digo por tel&eacute;fono, SMS o chat.
        </p>
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0;" />

      <div lang="en" style="margin:24px 0;">
        <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">
          ENGLISH
        </p>

        <h2 style="margin:0 0 10px;color:#111827;font-size:22px;">
          Confirm your sign-in
        </h2>

        <p style="margin:0 0 14px;color:#374151;">
          Use the security code above to complete your Pin&amp;Go sign-in.
        </p>

        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:16px;margin:16px 0;">
          <p style="margin:0;color:#1e40af;">
            <strong>Expires in 5 minutes.</strong> This code is personal and single-use. Do not share it with anyone.
          </p>
        </div>

        <p style="margin:0;color:#475569;font-size:13px;">
          If you did not try to sign in, you can ignore this email. Pin&amp;Go will never ask you for this code by phone, SMS, or chat.
        </p>
      </div>

      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;margin-top:24px;">
        <p style="margin:0;color:#64748b;font-size:12px;text-align:center;">
          Mensaje autom&aacute;tico de seguridad de Pin&amp;Go / Automated Pin&amp;Go security message
        </p>
      </div>
    </div>
  `;
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
  const env: MfaEmailDeliveryEnvironment =
    options.env ?? readProcessMfaEmailEnvironment();
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
    html: renderMfaEmailHtml(code),
  });

  return {
    delivered: true,
    mode,
    providerMessageId: result.providerMessageId,
  };
}
