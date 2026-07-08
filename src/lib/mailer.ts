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

type CancellationRefundRuleEmailInput = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
  label: string;
  description?: string | null;
};

type SendDirectBookingGuestConfirmationInput = {
  to: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  manageReservationUrl?: string | null;
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?: CancellationRefundRuleEmailInput[] | null;
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
  propertyTimeZone?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
};

type SendManualReservationGuestConfirmationInput = {
  to: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  manageReservationUrl?: string | null;
};

type SendDirectBookingGuestCancellationEmailInput = {
  to: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  cancelledAt?: Date | string | null;
  refundExecution?: string | null;
  refundAmount?: number | null;
  refundStatus?: string | null;
  stripeRefundId?: string | null;
  refundMode?: string | null;
  refundBasis?: string | null;
  nonRefundableAmount?: number | null;
  manageReservationUrl?: string | null;
};

type SendDirectBookingHostCancellationNotificationInput = {
  to: string;
  hostName?: string | null;
  propertyName: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  cancelledAt?: Date | string | null;
  refundExecution?: string | null;
  refundAmount?: number | null;
  refundStatus?: string | null;
  stripeRefundId?: string | null;
  refundMode?: string | null;
  refundBasis?: string | null;
  paymentState?: string | null;
  hostPayoutStatus?: string | null;
};

function getEmailFrom() {
  if (emailFrom) return emailFrom;

  if (isProd) {
    throw new Error("EMAIL_FROM missing in production");
  }

  return "Pin&Go <onboarding@resend.dev>";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSafeUrl(value?: string | null) {
  const url = String(value ?? "").trim();

  if (!url) return null;

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  return url;
}

const DEFAULT_BOOKING_EMAIL_TIME_ZONE = "America/Puerto_Rico";

function normalizePropertyTimeZone(value?: string | null) {
  const timeZone = String(value ?? "").trim() || DEFAULT_BOOKING_EMAIL_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_BOOKING_EMAIL_TIME_ZONE;
  }
}

function formatBookingDate(date: Date, timeZone?: string | null) {
  const safeTimeZone = normalizePropertyTimeZone(timeZone);

  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatBookingDateTime(
  value?: Date | string | null,
  timeZone?: string | null
) {
  if (!value) return "Not available";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return "Not available";

  const safeTimeZone = normalizePropertyTimeZone(timeZone);

  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatBookingAmount(amount?: number | null, currency?: string | null) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    return "Not available";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

function formatRefundBasis(value?: string | null) {
  if (value === "NIGHTLY_SUBTOTAL") {
    return "Nightly subtotal only";
  }

  if (value === "NIGHTLY_PLUS_CLEANING") {
    return "Nightly subtotal + cleaning fee";
  }

  if (value === "CUSTOM") {
    return "Custom refundable base";
  }

  return "Total reservation amount";
}

function formatCancellationWindow(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) {
    return "After the final refund window";
  }

  const days = hours / 24;

  if (Number.isInteger(days) && days >= 1) {
    return `${days} day${days === 1 ? "" : "s"} or more before check-in`;
  }

  return `${hours} hour${hours === 1 ? "" : "s"} or more before check-in`;
}

function getRefundExecutionTitle(value?: string | null) {
  if (value === "FULL_REFUND_EXECUTED") {
    return "Refund processed";
  }

  if (value === "PARTIAL_REFUND_EXECUTED") {
    return "Partial refund processed";
  }

  if (value === "NO_REFUND_DUE") {
    return "Reservation cancelled with no refund";
  }

  if (value === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return "Refund pending property workflow";
  }

  if (value === "HOST_APPROVAL_REQUIRED") {
    return "Host approval required";
  }

  return "Cancellation recorded";
}

function getRefundExecutionBody({
  refundExecution,
  refundAmount,
  currency,
  refundBasis,
}: {
  refundExecution?: string | null;
  refundAmount?: number | null;
  currency?: string | null;
  refundBasis?: string | null;
}) {
  const amountLabel = formatBookingAmount(refundAmount, currency);
  const basisLabel = formatRefundBasis(refundBasis);

  if (refundExecution === "FULL_REFUND_EXECUTED") {
    return `Pin&Go cancelled the reservation and submitted the eligible refund of ${amountLabel} through Stripe.`;
  }

  if (refundExecution === "PARTIAL_REFUND_EXECUTED") {
    return `Pin&Go cancelled the reservation and submitted the eligible partial refund of ${amountLabel} through Stripe. The refund was calculated using: ${basisLabel}.`;
  }

  if (refundExecution === "NO_REFUND_DUE") {
    return "Pin&Go cancelled the reservation. No refund is due according to the cancellation policy accepted at booking.";
  }

  if (refundExecution === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return `Pin&Go cancelled the reservation and recorded the eligible refund amount of ${amountLabel}. The property refund workflow will complete the next step.`;
  }

  return "Pin&Go recorded the cancellation according to the reservation cancellation policy.";
}

function renderManageReservationBlock(manageReservationUrl?: string | null) {
  const safeManageReservationUrl = getSafeUrl(manageReservationUrl);

  if (!safeManageReservationUrl) return "";

  const escapedUrl = escapeHtml(safeManageReservationUrl);

  return `
    <p style="margin: 24px 0;">
      <a href="${escapedUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:800;">
        Manage your reservation
      </a>
    </p>

    <p style="margin: 0 0 18px; color:#6b7280; font-size:13px; line-height:1.5;">
      Use this secure link to review your reservation, cancellation terms, and self-service options:
      <br />
      <a href="${escapedUrl}" style="color:#2563eb;">${escapedUrl}</a>
    </p>
  `;
}

function renderCancellationPolicyBlock({
  cancellationPolicyName,
  cancellationPolicyType,
  cancellationPolicySummary,
  refundBasis,
  refundRules,
}: {
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?: CancellationRefundRuleEmailInput[] | null;
}) {
  const hasPolicyContent =
    cancellationPolicyName ||
    cancellationPolicyType ||
    cancellationPolicySummary ||
    refundBasis ||
    (Array.isArray(refundRules) && refundRules.length > 0);

  if (!hasPolicyContent) return "";

  const safeRules = Array.isArray(refundRules) ? refundRules : [];

  return `
    <div style="background:#f8fafc;border:1px solid #dbeafe;border-radius:14px;padding:16px;margin:20px 0;">
      <h3 style="margin:0 0 10px;color:#111827;font-size:16px;">Cancellation terms</h3>

      ${
        cancellationPolicyName || cancellationPolicyType
          ? `<p style="margin:0 0 8px;"><strong>Policy:</strong> ${escapeHtml(
              cancellationPolicyName || cancellationPolicyType || "Configured by host"
            )}</p>`
          : ""
      }

      ${
        refundBasis
          ? `<p style="margin:0 0 8px;"><strong>Refund basis:</strong> ${escapeHtml(
              formatRefundBasis(refundBasis)
            )}</p>`
          : ""
      }

      ${
        cancellationPolicySummary
          ? `<p style="margin:10px 0;color:#374151;">${escapeHtml(
              cancellationPolicySummary
            )}</p>`
          : ""
      }

      ${
        safeRules.length > 0
          ? `
            <div style="margin-top:12px;">
              ${safeRules
                .map(
                  (rule) => `
                    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px;">
                      <p style="margin:0;font-weight:800;color:#111827;">
                        ${escapeHtml(rule.label)} — ${escapeHtml(rule.refundPercent)}%
                      </p>
                      <p style="margin:4px 0 0;color:#4b5563;font-size:13px;">
                        ${escapeHtml(formatCancellationWindow(rule.minHoursBeforeCheckIn))}
                      </p>
                      ${
                        rule.description
                          ? `<p style="margin:6px 0 0;color:#6b7280;font-size:13px;">${escapeHtml(
                              rule.description
                            )}</p>`
                          : ""
                      }
                    </div>
                  `
                )
                .join("")}
            </div>
          `
          : ""
      }

      ${
        refundBasis === "NIGHTLY_SUBTOTAL"
          ? `
            <p style="margin:12px 0 0;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;font-size:13px;">
              Refund percentages apply to the nightly subtotal only. Other charges such as cleaning fees, service fees, taxes, add-ons, or other non-nightly charges may not be refundable unless required by law or specifically stated in this policy.
            </p>
          `
          : ""
      }
    </div>
  `;
}

export async function sendResetPasswordEmail(
  input: SendResetPasswordEmailInput
) {
  const { to, resetUrl } = input;
  const safeResetUrl = escapeHtml(resetUrl);

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
            <a href="${safeResetUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 10px; font-weight: 700;">
              Reset password
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p><a href="${safeResetUrl}">${safeResetUrl}</a></p>
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
  const safeName = escapeHtml(name?.trim() || "there");

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

export async function sendDirectBookingGuestConfirmation(
  input: SendDirectBookingGuestConfirmationInput
) {
  const {
    to,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    totalAmount,
    currency,
    manageReservationUrl,
    cancellationPolicyName,
    cancellationPolicyType,
    cancellationPolicySummary,
    refundBasis,
    refundRules,
  } = input;

  const safeName = escapeHtml(guestName?.trim() || "there");
  const safePropertyName = escapeHtml(propertyName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);

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

  const manageReservationBlock = renderManageReservationBlock(
    manageReservationUrl
  );

  const cancellationPolicyBlock = renderCancellationPolicyBlock({
    cancellationPolicyName,
    cancellationPolicyType,
    cancellationPolicySummary,
    refundBasis,
    refundRules,
  });

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `Your Pin&Go reservation is confirmed - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
        <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">Pin&Go Direct Booking</p>
          <h1 style="margin:0;font-size:28px;line-height:1.15;">Your reservation is confirmed</h1>
          <p style="margin:10px 0 0;color:#dbeafe;">Pin&Go has started the secure stay workflow for your reservation.</p>
        </div>

        <p>Hi ${safeName},</p>

        <p>
          Your reservation for <strong>${safePropertyName}</strong> has been confirmed.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
          <p><strong>Property:</strong> ${safePropertyName}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn, dateTimeZone)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut, dateTimeZone)}</p>
          <p><strong>Total paid:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
          <p><strong>Payment status:</strong> Paid</p>
        </div>

        ${manageReservationBlock}

        ${cancellationPolicyBlock}

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin:20px 0;color:#14532d;">
          <h3 style="margin:0 0 8px;">Smart access and check-in</h3>
          <p style="margin:0;">
            Your smart access instructions will be delivered according to the property's secure check-in workflow.
            For security, access details may be delivered closer to check-in or after operational checks are complete.
          </p>
        </div>

        <p style="color:#4b5563;">
          You can use the manage reservation link to review your stay details, cancellation terms, and self-service options.
        </p>

        <p>
          Thank you,<br />
          Pin&Go
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />

        <h2 style="margin-bottom: 8px;">Tu reservación está confirmada</h2>

        <p>Hola ${safeName},</p>

        <p>
          Tu reservación para <strong>${safePropertyName}</strong> ha sido confirmada.
        </p>

        <p>
          Pin&Go comenzó el flujo seguro de estadía: confirmación de reserva,
          manejo de términos de cancelación, preparación operacional y acceso inteligente.
        </p>

        <p>
          Las instrucciones de acceso inteligente se entregarán según el flujo seguro de check-in de la propiedad.
          Por seguridad, los detalles de acceso pueden enviarse más cerca del check-in o después de completar validaciones operacionales.
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

export async function sendManualReservationGuestConfirmation(
  input: SendManualReservationGuestConfirmationInput
) {
  const {
    to,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    manageReservationUrl,
  } = input;

  const safeName = escapeHtml(guestName?.trim() || "there");
  const safePropertyName = escapeHtml(propertyName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);
  const manageReservationBlock = renderManageReservationBlock(
    manageReservationUrl
  );

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Manual reservation guest email fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `Your Pin&Go reservation is confirmed - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
        <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">Pin&Go Reservation</p>
          <h1 style="margin:0;font-size:28px;line-height:1.15;">Your reservation is confirmed</h1>
          <p style="margin:10px 0 0;color:#dbeafe;">Pin&Go has started the secure stay workflow for your reservation.</p>
        </div>

        <p>Hi ${safeName},</p>

        <p>
          Your reservation for <strong>${safePropertyName}</strong> has been confirmed.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
          <p><strong>Property:</strong> ${safePropertyName}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn, dateTimeZone)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut, dateTimeZone)}</p>
        </div>

        ${manageReservationBlock}

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin:20px 0;color:#14532d;">
          <h3 style="margin:0 0 8px;">Smart access and check-in</h3>
          <p style="margin:0;">
            Your smart access instructions will be delivered according to the property's secure check-in workflow.
            For security, access details may be delivered closer to check-in or after operational checks are complete.
          </p>
        </div>

        <p style="color:#4b5563;">
          You can use the manage reservation link to review your stay details and self-service options.
        </p>

        <p>
          Thank you,<br />
          Pin&Go
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />

        <h2 style="margin-bottom: 8px;">Tu reservación está confirmada</h2>

        <p>Hola ${safeName},</p>

        <p>
          Tu reservación para <strong>${safePropertyName}</strong> ha sido confirmada.
        </p>

        <p>
          Pin&Go comenzó el flujo seguro de estadía: confirmación de reserva,
          preparación operacional y acceso inteligente.
        </p>

        <p>
          Las instrucciones de acceso inteligente se entregarán según el flujo seguro de check-in de la propiedad.
          Por seguridad, los detalles de acceso pueden enviarse más cerca del check-in o después de completar validaciones operacionales.
        </p>

        <p>
          Gracias,<br />
          Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend manual reservation guest email failed: ${error.message}`);
  }

  console.log("✅ MANUAL RESERVATION GUEST EMAIL SENT TO:", to);

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
    propertyTimeZone,
    totalAmount,
    currency,
  } = input;

  const safeHostName = escapeHtml(hostName?.trim() || "there");
  const safePropertyName = escapeHtml(propertyName);
  const safeGuestName = escapeHtml(guestName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);

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
          A new direct booking has been completed for <strong>${safePropertyName}</strong>.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px 0;">
          <p><strong>Guest:</strong> ${safeGuestName}</p>
          <p><strong>Email:</strong> ${escapeHtml(guestEmail || "Not provided")}</p>
          <p><strong>Phone:</strong> ${escapeHtml(guestPhone || "Not provided")}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn, dateTimeZone)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut, dateTimeZone)}</p>
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

export async function sendDirectBookingGuestCancellationEmail(
  input: SendDirectBookingGuestCancellationEmailInput
) {
  const {
    to,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    totalAmount,
    currency,
    cancelledAt,
    refundExecution,
    refundAmount,
    refundStatus,
    stripeRefundId,
    refundMode,
    refundBasis,
    nonRefundableAmount,
    manageReservationUrl,
  } = input;

  const safeName = escapeHtml(guestName?.trim() || "there");
  const safePropertyName = escapeHtml(propertyName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);
  const safeStripeRefundId = stripeRefundId ? escapeHtml(stripeRefundId) : null;
  const title = getRefundExecutionTitle(refundExecution);
  const body = getRefundExecutionBody({
    refundExecution,
    refundAmount,
    currency,
    refundBasis,
  });
  const manageReservationBlock = renderManageReservationBlock(
    manageReservationUrl
  );

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Direct booking guest cancellation fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `${title} - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
        <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">Pin&Go Cancellation Update</p>
          <h1 style="margin:0;font-size:28px;line-height:1.15;">${escapeHtml(title)}</h1>
          <p style="margin:10px 0 0;color:#dbeafe;">${escapeHtml(body)}</p>
        </div>

        <p>Hi ${safeName},</p>

        <p>
          Your reservation for <strong>${safePropertyName}</strong> has been cancelled.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
          <p><strong>Property:</strong> ${safePropertyName}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn, dateTimeZone)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut, dateTimeZone)}</p>
          <p><strong>Cancelled at:</strong> ${formatBookingDateTime(cancelledAt, dateTimeZone)}</p>
          <p><strong>Total paid:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
          <p><strong>Refund amount:</strong> ${formatBookingAmount(refundAmount, currency)}</p>
          <p><strong>Refund basis:</strong> ${escapeHtml(formatRefundBasis(refundBasis))}</p>
          ${
            nonRefundableAmount !== null && nonRefundableAmount !== undefined
              ? `<p><strong>Non-refundable / remaining charges:</strong> ${formatBookingAmount(
                  nonRefundableAmount,
                  currency
                )}</p>`
              : ""
          }
          ${
            refundMode
              ? `<p><strong>Refund mode:</strong> ${escapeHtml(refundMode)}</p>`
              : ""
          }
          ${
            refundStatus
              ? `<p><strong>Refund status:</strong> ${escapeHtml(refundStatus)}</p>`
              : ""
          }
          ${
            safeStripeRefundId
              ? `<p><strong>Stripe refund ID:</strong> ${safeStripeRefundId}</p>`
              : ""
          }
        </div>

        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:14px;margin:20px 0;color:#92400e;">
          Refund timing can depend on Stripe, your card issuer, and your bank. Any non-refundable charges remain subject to the cancellation terms accepted at booking.
        </div>

        ${manageReservationBlock}

        <p>
          Thank you,<br />
          Pin&Go
        </p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />

        <h2 style="margin-bottom: 8px;">Actualización de cancelación</h2>

        <p>Hola ${safeName},</p>

        <p>
          Tu reservación para <strong>${safePropertyName}</strong> fue cancelada.
        </p>

        <p>
          Pin&Go evaluó los términos aceptados al momento de reservar y registró
          el resultado de cancelación y reembolso correspondiente.
        </p>

        <p>
          Gracias,<br />
          Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend guest cancellation email failed: ${error.message}`);
  }

  console.log("✅ DIRECT BOOKING GUEST CANCELLATION EMAIL SENT TO:", to);

  return {
    ok: true,
    mode: "resend",
    data,
  };
}

export async function sendDirectBookingHostCancellationNotification(
  input: SendDirectBookingHostCancellationNotificationInput
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
    propertyTimeZone,
    totalAmount,
    currency,
    cancelledAt,
    refundExecution,
    refundAmount,
    refundStatus,
    stripeRefundId,
    refundMode,
    refundBasis,
    paymentState,
    hostPayoutStatus,
  } = input;

  const safeHostName = escapeHtml(hostName?.trim() || "there");
  const safePropertyName = escapeHtml(propertyName);
  const safeGuestName = escapeHtml(guestName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);
  const title = getRefundExecutionTitle(refundExecution);

  if (!resend) {
    if (isProd) {
      throw new Error("RESEND_API_KEY missing in production");
    }

    console.log("📨 RESEND_API_KEY missing. Direct booking host cancellation fallback.");
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } = await resend.emails.send({
    from: getEmailFrom(),
    to,
    subject: `Reservation cancelled - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
        <h2 style="margin-bottom: 8px;">Reservation cancelled</h2>

        <p>Hi ${safeHostName},</p>

        <p>
          Pin&Go recorded a guest cancellation for <strong>${safePropertyName}</strong>.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
          <p><strong>Guest:</strong> ${safeGuestName}</p>
          <p><strong>Email:</strong> ${escapeHtml(guestEmail || "Not provided")}</p>
          <p><strong>Phone:</strong> ${escapeHtml(guestPhone || "Not provided")}</p>
          <p><strong>Check-in:</strong> ${formatBookingDate(checkIn, dateTimeZone)}</p>
          <p><strong>Check-out:</strong> ${formatBookingDate(checkOut, dateTimeZone)}</p>
          <p><strong>Cancelled at:</strong> ${formatBookingDateTime(cancelledAt, dateTimeZone)}</p>
          <p><strong>Total paid:</strong> ${formatBookingAmount(totalAmount, currency)}</p>
          <p><strong>Cancellation result:</strong> ${escapeHtml(title)}</p>
          <p><strong>Refund amount:</strong> ${formatBookingAmount(refundAmount, currency)}</p>
          <p><strong>Refund basis:</strong> ${escapeHtml(formatRefundBasis(refundBasis))}</p>
          ${
            refundMode
              ? `<p><strong>Refund mode:</strong> ${escapeHtml(refundMode)}</p>`
              : ""
          }
          ${
            refundStatus
              ? `<p><strong>Refund status:</strong> ${escapeHtml(refundStatus)}</p>`
              : ""
          }
          ${
            stripeRefundId
              ? `<p><strong>Stripe refund ID:</strong> ${escapeHtml(stripeRefundId)}</p>`
              : ""
          }
          ${
            paymentState
              ? `<p><strong>Payment state:</strong> ${escapeHtml(paymentState)}</p>`
              : ""
          }
          ${
            hostPayoutStatus
              ? `<p><strong>Host payout status:</strong> ${escapeHtml(
                  hostPayoutStatus
                )}</p>`
              : ""
          }
        </div>

        <p>
          Pin&Go updated the reservation, access workflow, payout/refund evidence, and distribution sync automatically.
        </p>

        <p>
          Best,<br />
          Pin&Go
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend host cancellation email failed: ${error.message}`);
  }

  console.log("✅ DIRECT BOOKING HOST CANCELLATION EMAIL SENT TO:", to);

  return {
    ok: true,
    mode: "resend",
    data,
  };
}
