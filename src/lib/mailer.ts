import { Resend } from "resend";

const resendApiKey = String(process.env.RESEND_API_KEY ?? "").trim();
const emailFrom = String(
  process.env.EMAIL_FROM ?? "Pin&Go <onboarding@resend.dev>"
).trim();

const resend = resendApiKey ? new Resend(resendApiKey) : null;

type SendResetPasswordEmailInput = {
  to: string;
  resetUrl: string;
};

export async function sendResetPasswordEmail(
  input: SendResetPasswordEmailInput
) {
  const { to, resetUrl } = input;

  if (!resend) {
    console.log("📨 RESEND_API_KEY missing. Using console fallback.");
    console.log("🔑 RESET LINK:", resetUrl);

    return {
      ok: true,
      mode: "console",
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to,
      subject: "Reset your Pin&Go password",
      html: `
        <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
          <h2 style="margin-bottom: 8px;">Reset your Pin&Go password</h2>
          <p style="margin-top: 0;">
            We received a request to reset your password.
          </p>
          <p>
            Click the button below to choose a new password:
          </p>
          <p style="margin: 24px 0;">
            <a
              href="${resetUrl}"
              style="
                display: inline-block;
                background: #2563eb;
                color: #ffffff;
                text-decoration: none;
                padding: 12px 18px;
                border-radius: 10px;
                font-weight: 700;
              "
            >
              Reset password
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p>
            <a href="${resetUrl}">${resetUrl}</a>
          </p>
          <p>This link expires in 45 minutes.</p>
          <p style="color: #6b7280; font-size: 13px;">
            If you did not request this change, you can ignore this email.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error("❌ Resend send failed. Using console fallback:", error);
      console.log("🔑 RESET LINK:", resetUrl);

      return {
        ok: true,
        mode: "console-fallback",
      };
    }

    console.log("✅ RESET EMAIL SENT TO:", to);

    return {
      ok: true,
      mode: "resend",
      data,
    };
  } catch (err) {
    console.error("❌ Resend exception. Using console fallback:", err);
    console.log("🔑 RESET LINK:", resetUrl);

    return {
      ok: true,
      mode: "console-fallback",
    };
  }
}