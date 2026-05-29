import { Resend } from "resend";

const resendApiKey = String(process.env.RESEND_API_KEY ?? "").trim();
const emailFrom = String(process.env.EMAIL_FROM ?? "").trim();
const isProd = process.env.NODE_ENV === "production";

const resend = resendApiKey ? new Resend(resendApiKey) : null;

type SendResetPasswordEmailInput = {
  to: string;
  resetUrl: string;
};

type SendSalesFollowUpEmailInput = {
  to: string;
  name?: string | null;
};

type SendDirectBookingGuestConfirmationInput = {
  to: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  totalAmount?: number | null;
  currency?: string | null;
};

type SendDirectBookingHostNotificationInput = {
  to: string;
  hostName?: string | null;
  propertyName: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  totalAmount?: number | null;
  currency?: string | null;
};

function getEmailFrom() {
  if (emailFrom) return emailFrom;

  if (isProd) {
    throw new Error("EMAIL_FROM missing in production");
  }

  return "Pin&Go <onboarding@resend.dev>";
}

export async function sendResetPasswordEmail(
  input: SendResetPasswordEmailInput
) {
  const { to, resetUrl } = input;

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Using console fallback.");
    console.log("✅ RESET PASSWORD EMAIL READY");

    return {
      ok: true,
      mode: "console",
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject: "Reset your Pin&Go password",
      html: `
        <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
          <h2 style="margin-bottom: 8px;">Reset your Pin&Go password</h2>
          <p style="margin-top: 0;">We received a request to reset your password.</p>
          <p>Click the button below to choose a new password:</p>
          <p style="margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 10px; font-weight: 700;">
              Reset password
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 45 minutes.</p>
          <p style="color: #6b7280; font-size: 13px;">
            If you did not request this change, you can ignore this email.
          </p>
        </div>
      `,
    });

    if (error) {
      if (isProd) {
        throw new Error(`Resend send failed: ${error.message}`);
      }

      console.error("❌ Resend send failed. Using console fallback:", error);
      console.log("✅ RESET PASSWORD EMAIL READY");

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
    if (isProd) {
      throw err;
    }

    console.error("❌ Resend exception. Using console fallback:", err);
    console.log("✅ RESET PASSWORD EMAIL READY");

    return {
      ok: true,
      mode: "console-fallback",
    };
  }
}

export async function sendSalesFollowUpEmail(
  input: SendSalesFollowUpEmailInput
) {
  const { to, name } = input;
  const safeName = name?.trim() || "there";

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Sales follow-up fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: "Following up on your Pin&Go demo",
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <h2 style="margin-bottom: 8px;">Following up on your Pin&Go demo</h2>

        <p>Hi ${safeName},</p>

        <p>
          Thank you for booking a Pin&Go demo. I wanted to follow up and see
          if you had any questions or if you would like help getting started.
        </p>

        <p>
          Pin&Go helps short-term rental operators automate guest access,
          PMS sync, messaging, and smart property automation.
        </p>

        <p>
          Best,<br />
          Pin&Go Team
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

        <h2 style="margin-bottom: 8px;">Seguimiento de tu demo de Pin&Go</h2>

        <p>Hola ${safeName},</p>

        <p>
          Gracias por agendar una demo de Pin&Go. Quería darte seguimiento
          para saber si tienes alguna pregunta o si deseas ayuda para comenzar.
        </p>

        <p>
          Pin&Go ayuda a operadores de rentas a corto plazo a automatizar
          accesos, sincronización con PMS, mensajería y automatización
          inteligente de propiedades.
        </p>

        <p>
          Saludos,<br />
          Equipo de Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend sales follow-up failed: ${error.message}`);
  }

  console.log("✅ SALES FOLLOW-UP EMAIL SENT TO:", to);

  return {
    ok: true,
    mode: "resend",
    data,
  };
}

function formatBookingDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatBookingAmount(amount?: number | null, currency?: string | null) {
  if (!amount || !Number.isFinite(Number(amount))) return "Not available";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(Number(amount));
}

export async function sendDirectBookingGuestConfirmation(
  input: SendDirectBookingGuestConfirmationInput
) {
  const {
    to,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    totalAmount,
    currency,
  } = input;

  const safeName = guestName?.trim() || "there";

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Direct booking guest email fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `Your reservation is confirmed - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <h2 style="margin-bottom: 8px;">Your reservation is confirmed</h2>

        <p>Hi ${safeName},</p>

        <p>
          Your reservation for <strong>${propertyName}</strong> has been confirmed.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px 0;">
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut)}</p>
          <p><strong>Total paid:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
        </div>

        <p>
          You will receive your check-in and access instructions before arrival.
        </p>

        <p>
          Thank you,<br />
          Pin&Go
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

        <h2 style="margin-bottom: 8px;">Tu reservación está confirmada</h2>

        <p>Hola ${safeName},</p>

        <p>
          Tu reservación para <strong>${propertyName}</strong> ha sido confirmada.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px 0;">
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut)}</p>
          <p><strong>Total pagado:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
        </div>

        <p>
          Recibirás las instrucciones de acceso antes de tu llegada.
        </p>

        <p>
          Gracias,<br />
          Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend direct booking guest email failed: ${error.message}`);
  }

  console.log("✅ DIRECT BOOKING GUEST EMAIL SENT TO:", to);

  return {
    ok: true,
    mode: "resend",
    data,
  };
}

export async function sendDirectBookingHostNotification(
  input: SendDirectBookingHostNotificationInput
) {
  const {
    to,
    hostName,
    propertyName,
    guestName,
    guestEmail,
    guestPhone,
    checkIn,
    checkOut,
    totalAmount,
    currency,
  } = input;

  const safeHostName = hostName?.trim() || "there";

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Direct booking host email fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `New direct booking - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <h2 style="margin-bottom: 8px;">New direct booking received</h2>

        <p>Hi ${safeHostName},</p>

        <p>
          A new direct booking has been completed for <strong>${propertyName}</strong>.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px 0;">
          <p><strong>Guest:</strong> ${guestName}</p>
          <p><strong>Email:</strong> ${guestEmail || "Not provided"}</p>
          <p><strong>Phone:</strong> ${guestPhone || "Not provided"}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut)}</p>
          <p><strong>Total paid:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
        </div>

        <p>
          Pin&Go has created the reservation and started the operational flow automatically.
        </p>

        <p>
          Best,<br />
          Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend direct booking host email failed: ${error.message}`);
  }

  console.log("✅ DIRECT BOOKING HOST EMAIL SENT TO:", to);

  return {
    ok: true,
    mode: "resend",
    data,
  };
}