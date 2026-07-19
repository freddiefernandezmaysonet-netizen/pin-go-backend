import { Resend } from "resend";
import {
  buildGuestReservationEmail,
} from "./email-templates/guestReservationEmail";
import {
  getGuestIntlLocale,
  resolveGuestLanguage,
  type GuestLanguage,
} from "../services/guest-language.service";

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

type SendGuestAccessPasscodeEmailInput = {
  to: string;
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;
  passcode: string;
  unlockKey?: string | null;
  validFrom: Date;
  validUntil: Date;
  propertyTimeZone?: string | null;
  preferredLanguage?: string | null;
};

type CancellationRefundRuleEmailInput = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
  label: string;
  description?: string | null;
};

type SendDirectBookingGuestConfirmationInput = {
  to: string;
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  manageReservationUrl?: string | null;
  verificationUrl?: string | null;
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?: CancellationRefundRuleEmailInput[] | null;
  preferredLanguage?: string | null;
};

type SendDirectBookingHostNotificationInput = {
  to: string;
  reservationNumber: string;
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
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  propertyTimeZone?: string | null;
  verificationUrl: string;
  preferredLanguage?: string | null;
};

type SendDirectBookingGuestCancellationEmailInput = {
  to: string;
  reservationNumber: string;
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
  preferredLanguage?: string | null;
};

type SendDirectBookingHostCancellationNotificationInput = {
  to: string;
  reservationNumber: string;
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

function formatBookingDate(
  date: Date,
  timeZone?: string | null,
  language: GuestLanguage = "en"
) {
  const safeTimeZone = normalizePropertyTimeZone(timeZone);

  return new Intl.DateTimeFormat(getGuestIntlLocale(language), {
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
  timeZone?: string | null,
  language: GuestLanguage = "en"
) {
  if (!value) return language === "es" ? "No disponible" : "Not available";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return language === "es" ? "No disponible" : "Not available";
  }

  const safeTimeZone = normalizePropertyTimeZone(timeZone);

  return new Intl.DateTimeFormat(getGuestIntlLocale(language), {
    timeZone: safeTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatBookingAmount(
  amount?: number | null,
  currency?: string | null,
  language: GuestLanguage = "en"
) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    return language === "es" ? "No disponible" : "Not available";
  }

  return new Intl.NumberFormat(getGuestIntlLocale(language), {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

function formatRefundBasis(
  value?: string | null,
  language: GuestLanguage = "en"
) {
  const isSpanish = language === "es";
  if (value === "NIGHTLY_SUBTOTAL") {
    return isSpanish ? "Solo subtotal de noches" : "Nightly subtotal only";
  }

  if (value === "NIGHTLY_PLUS_CLEANING") {
    return isSpanish ? "Subtotal de noches + limpieza" : "Nightly subtotal + cleaning fee";
  }

  if (value === "CUSTOM") {
    return isSpanish ? "Base reembolsable personalizada" : "Custom refundable base";
  }

  return isSpanish ? "Importe total de la reservación" : "Total reservation amount";
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

function getRefundExecutionTitle(
  value?: string | null,
  language: GuestLanguage = "en"
) {
  const isSpanish = language === "es";
  if (value === "FULL_REFUND_EXECUTED") {
    return isSpanish ? "Reembolso procesado" : "Refund processed";
  }

  if (value === "PARTIAL_REFUND_EXECUTED") {
    return isSpanish ? "Reembolso parcial procesado" : "Partial refund processed";
  }

  if (value === "NO_REFUND_DUE") {
    return isSpanish ? "Reservación cancelada sin reembolso" : "Reservation cancelled with no refund";
  }

  if (value === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return isSpanish ? "Reembolso pendiente del proceso de la propiedad" : "Refund pending property workflow";
  }

  if (value === "HOST_APPROVAL_REQUIRED") {
    return isSpanish ? "Se requiere aprobación del anfitrión" : "Host approval required";
  }

  return isSpanish ? "Cancelación registrada" : "Cancellation recorded";
}

function getRefundExecutionBody({
  refundExecution,
  refundAmount,
  currency,
  refundBasis,
  language = "en",
}: {
  refundExecution?: string | null;
  refundAmount?: number | null;
  currency?: string | null;
  refundBasis?: string | null;
  language?: GuestLanguage;
}) {
  const isSpanish = language === "es";
  const amountLabel = formatBookingAmount(refundAmount, currency, language);
  const basisLabel = formatRefundBasis(refundBasis, language);

  if (refundExecution === "FULL_REFUND_EXECUTED") {
    return isSpanish
      ? `Pin&Go canceló la reservación y envió el reembolso elegible de ${amountLabel} mediante Stripe.`
      : `Pin&Go cancelled the reservation and submitted the eligible refund of ${amountLabel} through Stripe.`;
  }

  if (refundExecution === "PARTIAL_REFUND_EXECUTED") {
    return isSpanish
      ? `Pin&Go canceló la reservación y envió el reembolso parcial elegible de ${amountLabel} mediante Stripe. El cálculo utilizó: ${basisLabel}.`
      : `Pin&Go cancelled the reservation and submitted the eligible partial refund of ${amountLabel} through Stripe. The refund was calculated using: ${basisLabel}.`;
  }

  if (refundExecution === "NO_REFUND_DUE") {
    return isSpanish
      ? "Pin&Go canceló la reservación. No corresponde un reembolso según la política aceptada al reservar."
      : "Pin&Go cancelled the reservation. No refund is due according to the cancellation policy accepted at booking.";
  }

  if (refundExecution === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return isSpanish
      ? `Pin&Go canceló la reservación y registró el reembolso elegible de ${amountLabel}. El proceso de la propiedad completará el próximo paso.`
      : `Pin&Go cancelled the reservation and recorded the eligible refund amount of ${amountLabel}. The property refund workflow will complete the next step.`;
  }

  return isSpanish
    ? "Pin&Go registró la cancelación según la política de la reservación."
    : "Pin&Go recorded the cancellation according to the reservation cancellation policy.";
}

function renderManageReservationBlock(
  manageReservationUrl?: string | null,
  language: GuestLanguage = "en"
) {
  const safeManageReservationUrl =
    getSafeUrl(
      manageReservationUrl
    );

  if (!safeManageReservationUrl) {
    return "";
  }

  const escapedUrl =
    escapeHtml(
      safeManageReservationUrl
    );
  const isSpanish = language === "es";

  return `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:20px;margin:22px 0;">
      <h3 style="margin:0 0 8px;color:#1e3a8a;">
        ${isSpanish ? "Administre su reservaci&oacute;n" : "Manage your reservation"}
      </h3>

      <p style="margin:0 0 16px;color:#1e40af;">
        ${isSpanish
          ? "Revise los detalles de su estad&iacute;a, los t&eacute;rminos de cancelaci&oacute;n, la elegibilidad de reembolso y las opciones disponibles."
          : "Review your stay details, cancellation terms, refund eligibility, and available self-service options."}
      </p>

      <p style="margin:0 0 18px;">
        <a
          href="${escapedUrl}"
          style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:800;"
        >
          ${isSpanish ? "Administrar reservaci&oacute;n" : "Manage reservation"}
        </a>
      </p>

      <p style="margin:0;color:#475569;font-size:13px;">
        ${isSpanish ? "Enlace seguro" : "Secure link"}:
        <br />
        <a
          href="${escapedUrl}"
          style="color:#2563eb;word-break:break-all;"
        >
          ${escapedUrl}
        </a>
      </p>
    </div>
  `;
}

function renderCancellationPolicyBlock({
  cancellationPolicyName,
  cancellationPolicyType,
  cancellationPolicySummary,
  refundBasis,
  refundRules,
  language = "en",
}: {
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?:
    | CancellationRefundRuleEmailInput[]
    | null;
  language?: GuestLanguage;
}) {
  const isSpanish = language === "es";
  const hasPolicyContent =
    cancellationPolicyName ||
    cancellationPolicyType ||
    cancellationPolicySummary ||
    refundBasis ||
    (Array.isArray(refundRules) &&
      refundRules.length > 0);

  if (!hasPolicyContent) {
    return "";
  }

  const safeRules =
    Array.isArray(refundRules)
      ? refundRules
      : [];

  const refundBasisLabel =
    refundBasis ===
      "NIGHTLY_SUBTOTAL" ||
    refundBasis ===
      "NIGHTLY_SUBTOTAL_ONLY"
      ? isSpanish ? "Solo subtotal de noches" : "Nightly subtotal only"
      : refundBasis ===
        "NIGHTLY_PLUS_CLEANING"
      ? isSpanish ? "Noches y cargo de limpieza elegible" : "Nightly subtotal and eligible cleaning fee"
      : refundBasis ===
        "TOTAL_AMOUNT"
      ? isSpanish ? "Total elegible" : "Eligible total amount"
      : refundBasis
      ? isSpanish ? "Según la base configurada" : formatRefundBasis(refundBasis)
      : null;

  return `
    <div style="background:#f8fafc;border:1px solid #dbeafe;border-radius:14px;padding:16px;margin:20px 0;">
      <h3 style="margin:0 0 8px;color:#111827;">
        ${isSpanish ? "Pol&iacute;tica de cancelaci&oacute;n y reembolso" : "Cancellation &amp; refund policy"}
      </h3>

      ${
        cancellationPolicyName ||
        cancellationPolicyType
          ? `
            <p style="margin:0 0 8px;">
              <strong>${isSpanish ? "Pol&iacute;tica" : "Policy"}:</strong>
              ${escapeHtml(
                cancellationPolicyName ||
                  cancellationPolicyType ||
                  (isSpanish ? "Configurada por el anfitri&oacute;n" : "Configured by host")
              )}
            </p>
          `
          : ""
      }

      ${
        refundBasisLabel
          ? `
            <p style="margin:0 0 8px;">
              <strong>${isSpanish ? "Base del reembolso" : "Refund basis"}:</strong>
              ${escapeHtml(
                refundBasisLabel
              )}
            </p>
          `
          : ""
      }

      ${
        cancellationPolicySummary
          ? `
            <p style="margin:10px 0;color:#374151;">
              ${escapeHtml(
                cancellationPolicySummary
              )}
            </p>
          `
          : ""
      }

      ${
        safeRules.length > 0
          ? `
            <div style="margin-top:12px;">
              <p style="margin:0 0 8px;font-weight:800;">
                ${isSpanish ? "Calendario de reembolso" : "Refund schedule"}
              </p>

              ${safeRules
                .map((rule) => {
                  const daysBeforeCheckIn =
                    Math.max(
                      0,
                      Math.ceil(
                        Number(
                          rule.minHoursBeforeCheckIn
                        ) / 24
                      )
                    );

                  return `
                    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-top:8px;">
                      <p style="margin:0;font-weight:800;color:#111827;">
                        ${escapeHtml(
                          rule.label
                        )}
                        &mdash;
                        ${escapeHtml(
                          rule.refundPercent
                        )}%
                      </p>

                      <p style="margin:4px 0 0;color:#4b5563;font-size:13px;">
                        ${daysBeforeCheckIn}+
                        ${isSpanish ? "d&iacute;as antes del check-in" : "days before check-in"}
                      </p>

                      ${
                        rule.description
                          ? `
                            <p style="margin:6px 0 0;color:#6b7280;font-size:13px;">
                              ${escapeHtml(
                                rule.description
                              )}
                            </p>
                          `
                          : ""
                      }
                    </div>
                  `;
                })
                .join("")}
            </div>
          `
          : ""
      }

      ${
        refundBasis ===
          "NIGHTLY_SUBTOTAL" ||
        refundBasis ===
          "NIGHTLY_SUBTOTAL_ONLY"
          ? `
            <div style="margin:12px 0 0;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;font-size:13px;">
              <p style="margin:0;">
                ${isSpanish
                  ? "Los porcentajes de reembolso aplican solamente al subtotal de noches. Los cargos de limpieza, servicio, impuestos, complementos y otros cargos que no correspondan a noches pueden no ser reembolsables, salvo que la ley o la pol&iacute;tica indiquen lo contrario."
                  : "Refund percentages apply only to the nightly subtotal. Cleaning fees, service fees, taxes, add-ons, and other non-nightly charges may not be refundable unless required by law or specifically stated in the policy."}
              </p>
            </div>
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
  const {
    to,
    name,
  } = input;

  const safeName =
    escapeHtml(
      name?.trim() || "there"
    );

  if (!resend) {
    if (isProd) {
      throw new Error(
        "RESEND_API_KEY missing in production"
      );
    }

    console.log(
      "RESEND_API_KEY missing. Sales follow-up fallback."
    );
    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject:
        "Pin&Go demo follow-up / Seguimiento de demo",
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <h2 style="margin-bottom:8px;">
            Following up on your Pin&amp;Go demo
          </h2>

          <h2 style="margin-bottom:16px;">
            Seguimiento de su demo de Pin&amp;Go
          </h2>

          <p>
            Hi / Hola ${safeName},
          </p>

          <p>
            Thank you for booking a Pin&amp;Go demo. We wanted to follow up and see if you have any questions or would like help getting started.
          </p>

          <p>
            Gracias por agendar una demo de Pin&amp;Go. Queremos darle seguimiento para saber si tiene alguna pregunta o desea ayuda para comenzar.
          </p>

          <p>
            Pin&amp;Go helps short-term rental operators automate guest access, PMS synchronization, messaging, and smart-property operations.
          </p>

          <p>
            Pin&amp;Go ayuda a los operadores de alquileres a corto plazo a automatizar el acceso de hu&eacute;spedes, la sincronizaci&oacute;n con PMS, la mensajer&iacute;a y las operaciones inteligentes de la propiedad.
          </p>

          <p>
            Best / Saludos,<br />
            Pin&amp;Go Team / Equipo Pin&amp;Go
          </p>
        </div>
      `,
    });

  if (error) {
    throw new Error(
      `Resend sales follow-up failed: ${error.message}`
    );
  }

  console.log(
    "SALES FOLLOW-UP EMAIL SENT TO:",
    to
  );

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
    reservationNumber,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    totalAmount,
    currency,
    manageReservationUrl,
    verificationUrl,
    cancellationPolicyName,
    cancellationPolicyType,
    cancellationPolicySummary,
    refundBasis,
    refundRules,
    preferredLanguage,
  } = input;
  const language = resolveGuestLanguage(preferredLanguage);
  const isSpanish = language === "es";

  const dateTimeZone =
    normalizePropertyTimeZone(
      propertyTimeZone
    );

  if (!resend) {
    if (isProd) {
      throw new Error(
        "RESEND_API_KEY missing in production"
      );
    }

    console.log(
      "📨 RESEND_API_KEY missing. Direct booking guest email fallback."
    );

    console.log("TO:", to);

    return {
      ok: true,
      mode: "console",
    };
  }

  const manageReservationBlock =
    renderManageReservationBlock(
      manageReservationUrl,
      language
    );

  if (!manageReservationBlock) {
    throw new Error(
      "Direct booking manage reservation URL is missing or invalid"
    );
  }

  const cancellationPolicyBlock =
    renderCancellationPolicyBlock({
      ...(cancellationPolicyName !== undefined
        ? { cancellationPolicyName }
        : {}),
      ...(cancellationPolicyType !== undefined
        ? { cancellationPolicyType }
        : {}),
      ...(cancellationPolicySummary !== undefined
        ? { cancellationPolicySummary }
        : {}),
      ...(refundBasis !== undefined
        ? { refundBasis }
        : {}),
      ...(refundRules !== undefined
        ? { refundRules }
        : {}),
      language,
    });

 const safeVerificationUrl =
  getSafeUrl(verificationUrl);

if (!safeVerificationUrl) {
  throw new Error(
    "Direct booking verification URL is missing or invalid"
  );
}

const verificationBlock = `
      <div
        style="
          background:#eff6ff;
          border:1px solid #bfdbfe;
          border-radius:16px;
          padding:20px;
          margin:22px 0;
        "
      >
        <div lang="${language}">
          <p
            style="
              margin:0 0 6px;
              color:#1d4ed8;
              font-size:12px;
              font-weight:800;
              letter-spacing:0.08em;
              text-transform:uppercase;
            "
          >
            ${isSpanish ? "Acci&oacute;n requerida" : "Action required"}
          </p>

          <h2
            style="
              margin:0 0 10px;
              color:#1e3a8a;
            "
          >
            ${isSpanish ? "Complete el registro seguro" : "Complete secure pre-check-in"}
          </h2>

          <p
            style="
              margin:0 0 16px;
              color:#1e40af;
            "
          >
            ${isSpanish
              ? "Complete la verificaci&oacute;n de identidad, revise y acepte las reglas de la propiedad y la pol&iacute;tica de cancelaci&oacute;n, y firme el acuerdo del hu&eacute;sped antes de recibir el acceso digital."
              : "Complete identity verification, review and accept the property rules and cancellation policy, and sign the guest agreement before digital access is released."}
          </p>
        </div>

        <p style="margin:0 0 18px;">
          <a
            href="${escapeHtml(safeVerificationUrl)}"
            style="
              display:inline-block;
              background:#2563eb;
              color:#ffffff;
              text-decoration:none;
              padding:14px 20px;
              border-radius:12px;
              font-weight:800;
            "
          >
            ${isSpanish ? "Completar registro seguro" : "Complete pre-check-in"}
          </a>
        </p>

        <p
          style="
            margin:0;
            color:#475569;
            font-size:13px;
          "
        >
          ${isSpanish ? "Enlace seguro de verificaci&oacute;n" : "Secure verification link"}:
          <br />

          <a
            href="${escapeHtml(safeVerificationUrl)}"
            style="
              color:#2563eb;
              word-break:break-all;
            "
          >
            ${escapeHtml(safeVerificationUrl)}
          </a>
        </p>
      </div>
   `;
  const formattedTotalPaid =
    totalAmount !== null &&
    totalAmount !== undefined &&
    Number.isFinite(
      Number(totalAmount)
    )
      ? formatBookingAmount(
          totalAmount,
          currency,
          language
        )
      : undefined;

  const emailHtml =
    buildGuestReservationEmail({
      mode: "DIRECT_BOOKING",

      reservationNumber,
      guestName,
      propertyName,
      language,
      checkIn: formatBookingDate(checkIn, dateTimeZone, language),
      checkOut: formatBookingDate(checkOut, dateTimeZone, language),

      totalPaid:
        formattedTotalPaid,

      paymentStatus: isSpanish ? "Pagado" : "Paid",

      verificationBlock,
      manageReservationBlock,
      cancellationPolicyBlock,
    });

  const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),

      to,

      subject:
        `${isSpanish ? "Reservación confirmada" : "Reservation confirmed"} #${reservationNumber} - ${propertyName}`,

      html: emailHtml,
    });

  if (error) {
    throw new Error(
      `Resend direct booking guest email failed: ${error.message}`
    );
  }

  console.log(
    "✅ DIRECT BOOKING GUEST EMAIL SENT TO:",
    to
  );

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
    reservationNumber,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    verificationUrl,
    preferredLanguage,
  } = input;
  const language = resolveGuestLanguage(preferredLanguage);
  const isSpanish = language === "es";

  const safeReservationNumber =
    escapeHtml(reservationNumber);

  const safeName = escapeHtml(
    guestName?.trim() || (isSpanish ? "Huésped" : "there")
  );

  const safePropertyName =
    escapeHtml(propertyName);

  const dateTimeZone =
    normalizePropertyTimeZone(
      propertyTimeZone
    );

  const normalizedVerificationUrl =
    getSafeUrl(verificationUrl);

  if (!normalizedVerificationUrl) {
    throw new Error(
      "Manual reservation verification URL is missing or invalid"
    );
  }

  const safeVerificationUrl =
    escapeHtml(
      normalizedVerificationUrl
    );

  const verificationBlock = `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:20px;margin:22px 0;">
      <h2 style="margin:0 0 8px;color:#1e3a8a;">
        ${isSpanish ? "Registro seguro requerido" : "Secure pre-check-in required"}
      </h2>

      <p style="margin:0 0 10px;color:#1e40af;">
        ${isSpanish
          ? "Antes de que Pin&amp;Go entregue su acceso digital, complete la verificaci&oacute;n de identidad, revise y acepte las reglas de la propiedad y la pol&iacute;tica de cancelaci&oacute;n/reembolso, y firme el acuerdo del hu&eacute;sped."
          : "Before Pin&amp;Go releases your digital access, complete identity verification, review and accept the property rules and cancellation/refund policy, and sign the guest agreement."}
      </p>

      <p style="margin:0 0 18px;">
        <a
          href="${safeVerificationUrl}"
          style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:800;"
        >
          ${isSpanish ? "Complete el registro seguro" : "Complete secure pre-check-in"}
        </a>
      </p>

      <p style="margin:0;color:#475569;font-size:13px;">
        ${isSpanish ? "Enlace seguro" : "Secure link"}:
        <br />
        <a
          href="${safeVerificationUrl}"
          style="color:#2563eb;word-break:break-all;"
        >
          ${safeVerificationUrl}
        </a>
      </p>
    </div>
  `;
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

    const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject:
        `${isSpanish ? "Reservación - Registro seguro requerido" : "Reservation - Secure pre-check-in required"} #${reservationNumber} - ${propertyName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              ${isSpanish ? "Reservación Pin&amp;Go" : "Pin&amp;Go Reservation"}
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              ${isSpanish ? "Reservación creada" : "Reservation created"}
            </h1>

            <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
              ${isSpanish ? "Reservación" : "Reservation"} #${safeReservationNumber}
            </p>

            <p style="margin:8px 0 0;color:#dbeafe;">
              ${isSpanish
                ? "Debe completar el registro seguro antes de recibir el acceso digital."
                : "Secure pre-check-in must be completed before digital access can be released."}
            </p>
          </div>

          <p>
            ${isSpanish ? "Hola" : "Hi"} ${safeName},
          </p>

          <p>
            ${isSpanish ? "Su reservación para" : "Your reservation for"} <strong>${safePropertyName}</strong> ${isSpanish ? "ha sido creada." : "has been created."}
          </p>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
            <p>
              <strong>${isSpanish ? "Número de reservación" : "Reservation number"}:</strong>
              #${safeReservationNumber}
            </p>

            <p>
              <strong>${isSpanish ? "Propiedad" : "Property"}:</strong>
              ${safePropertyName}
            </p>

            <p>
              <strong>${isSpanish ? "Entrada" : "Check-in"}:</strong>
              ${formatBookingDate(
                checkIn,
                dateTimeZone,
                language
              )}
            </p>

            <p>
              <strong>${isSpanish ? "Salida" : "Check-out"}:</strong>
              ${formatBookingDate(
                checkOut,
                dateTimeZone,
                language
              )}
            </p>
          </div>

          ${verificationBlock}

          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:16px;margin:20px 0;color:#92400e;">
            <h3 style="margin:0 0 8px;">
              ${isSpanish ? "Pasos requeridos" : "Required steps"}
            </h3>

            <ul style="margin:0;padding-left:22px;">
              <li>
                ${isSpanish ? "Verificaci&oacute;n de identidad" : "Identity verification"}
              </li>
              <li>
                ${isSpanish ? "Acuerdo del hu&eacute;sped y reglas de la propiedad" : "Guest agreement and property rules"}
              </li>
              <li>
                ${isSpanish ? "Aceptaci&oacute;n de la pol&iacute;tica de cancelaci&oacute;n y reembolso" : "Cancellation and refund policy acceptance"}
              </li>
            </ul>

            <p style="margin:12px 0 0;">
              ${isSpanish
                ? "Las actualizaciones por SMS son opcionales y no son necesarias para completar la reservaci&oacute;n."
                : "SMS updates are optional and are not required to complete the reservation."}
            </p>
          </div>

          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin:20px 0;color:#14532d;">
            <h3 style="margin:0 0 8px;">
              ${isSpanish ? "Acceso inteligente" : "Smart access"}
            </h3>

            <p style="margin:0;">
              ${isSpanish
                ? "El acceso digital permanecer&aacute; protegido hasta completar los requisitos del registro seguro. Las instrucciones de acceso pueden enviarse m&aacute;s cerca del check-in, despu&eacute;s de completar las validaciones operacionales."
                : "Digital access remains protected until the secure pre-check-in requirements are completed. Access instructions may be delivered closer to check-in after operational checks are complete."}
            </p>
          </div>

          <p>
            ${isSpanish ? "Gracias" : "Thank you"},<br />
            Pin&amp;Go
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;" />

          <p style="color:#6b7280;font-size:12px;">
            ${isSpanish
              ? "Este es un mensaje transaccional relacionado con su reservaci&oacute;n."
              : "This is a transactional message regarding your reservation."}
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
    reservationNumber,
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

  const safeReservationNumber = escapeHtml(reservationNumber);
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
    subject: `New Reservation #${reservationNumber} - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <h2 style="margin-bottom: 8px;">New direct booking received</h2>

        <p>Hi ${safeHostName},</p>

        <p>
          A new direct booking has been completed for <strong>${safePropertyName}</strong>.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:20px 0;">
  <p><strong>Reservation Number:</strong> #${safeReservationNumber}</p>
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
    reservationNumber,
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
    preferredLanguage,
  } = input;
  const language = resolveGuestLanguage(preferredLanguage);
  const isSpanish = language === "es";

  const safeReservationNumber = escapeHtml(reservationNumber);
  const safeName = escapeHtml(
    guestName?.trim() || (isSpanish ? "Huésped" : "there")
  );
  const safePropertyName = escapeHtml(propertyName);
  const dateTimeZone = normalizePropertyTimeZone(propertyTimeZone);
  const safeStripeRefundId = stripeRefundId ? escapeHtml(stripeRefundId) : null;
  const title = getRefundExecutionTitle(refundExecution, language);
  const body = getRefundExecutionBody({
    ...(refundExecution !== undefined ? { refundExecution } : {}),
    ...(refundAmount !== undefined ? { refundAmount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(refundBasis !== undefined ? { refundBasis } : {}),
    language,
  });
  const manageReservationBlock = renderManageReservationBlock(
    manageReservationUrl,
    language
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
    subject: `${title} - ${isSpanish ? "Reservación" : "Reservation"} #${reservationNumber} - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
       <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">${isSpanish ? "Actualización de cancelación Pin&Go" : "Pin&Go Cancellation Update"}</p>
  <h1 style="margin:0;font-size:28px;line-height:1.15;">${escapeHtml(title)}</h1>
  <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">${isSpanish ? "Reservación" : "Reservation"} #${safeReservationNumber}</p>
  <p style="margin:8px 0 0;color:#dbeafe;">${escapeHtml(body)}</p>
</div>
        <p>${isSpanish ? "Hola" : "Hi"} ${safeName},</p>

        <p>
          ${isSpanish ? "Su reservación para" : "Your reservation for"} <strong>${safePropertyName}</strong> ${isSpanish ? "fue cancelada." : "has been cancelled."}
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
  <p><strong>${isSpanish ? "Número de reservación" : "Reservation number"}:</strong> #${safeReservationNumber}</p>
  <p><strong>${isSpanish ? "Propiedad" : "Property"}:</strong> ${safePropertyName}</p>
          <p><strong>${isSpanish ? "Entrada" : "Check-in"}:</strong> ${formatBookingDate(checkIn, dateTimeZone, language)}</p>
          <p><strong>${isSpanish ? "Salida" : "Check-out"}:</strong> ${formatBookingDate(checkOut, dateTimeZone, language)}</p>
          <p><strong>${isSpanish ? "Cancelada el" : "Cancelled at"}:</strong> ${formatBookingDateTime(cancelledAt, dateTimeZone, language)}</p>
          <p><strong>${isSpanish ? "Total pagado" : "Total paid"}:</strong> ${formatBookingAmount(totalAmount, currency, language)}</p>
          <p><strong>${isSpanish ? "Importe del reembolso" : "Refund amount"}:</strong> ${formatBookingAmount(refundAmount, currency, language)}</p>
          <p><strong>${isSpanish ? "Base del reembolso" : "Refund basis"}:</strong> ${escapeHtml(formatRefundBasis(refundBasis, language))}</p>
          ${
            nonRefundableAmount !== null && nonRefundableAmount !== undefined
              ? `<p><strong>${isSpanish ? "Cargos no reembolsables o restantes" : "Non-refundable / remaining charges"}:</strong> ${formatBookingAmount(
                  nonRefundableAmount,
                  currency,
                  language
                )}</p>`
              : ""
          }
          ${
            refundMode
              ? `<p><strong>${isSpanish ? "Modalidad del reembolso" : "Refund mode"}:</strong> ${escapeHtml(refundMode)}</p>`
              : ""
          }
          ${
            refundStatus
              ? `<p><strong>${isSpanish ? "Estado del reembolso" : "Refund status"}:</strong> ${escapeHtml(refundStatus)}</p>`
              : ""
          }
          ${
            safeStripeRefundId
              ? `<p><strong>${isSpanish ? "ID de reembolso de Stripe" : "Stripe refund ID"}:</strong> ${safeStripeRefundId}</p>`
              : ""
          }
        </div>

        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:14px;margin:20px 0;color:#92400e;">
          ${isSpanish
            ? "El tiempo del reembolso puede depender de Stripe, del emisor de su tarjeta y de su banco. Los cargos no reembolsables permanecen sujetos a los términos aceptados al reservar."
            : "Refund timing can depend on Stripe, your card issuer, and your bank. Any non-refundable charges remain subject to the cancellation terms accepted at booking."}
        </div>

        ${manageReservationBlock}

        <p>
          ${isSpanish ? "Gracias" : "Thank you"},<br />
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
    reservationNumber,
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

  const safeReservationNumber = escapeHtml(reservationNumber);
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
    subject: `Reservation #${reservationNumber} cancelled - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
        <h2 style="margin-bottom: 8px;">Reservation cancelled</h2>

<p style="font-weight:700;color:#1d4ed8;">
  Reservation #${safeReservationNumber}
</p>

<p>Hi ${safeHostName},</p>
        <p>
          Pin&Go recorded a guest cancellation for <strong>${safePropertyName}</strong>.
        </p>

       <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
  <p><strong>Reservation Number:</strong> #${safeReservationNumber}</p>
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

export async function sendGuestAccessPasscodeEmail(
  input: SendGuestAccessPasscodeEmailInput
) {
  const {
    to,
    reservationNumber,
    guestName,
    propertyName,
    passcode,
    unlockKey,
    validFrom,
    validUntil,
    propertyTimeZone,
    preferredLanguage,
  } = input;
  const language = resolveGuestLanguage(preferredLanguage);
  const isSpanish = language === "es";

  const safeReservationNumber =
    escapeHtml(reservationNumber);
  const safeGuestName = escapeHtml(
    guestName?.trim() || (isSpanish ? "Huésped" : "Guest")
  );
  const safePropertyName =
    escapeHtml(propertyName);
  const safePasscode = escapeHtml(passcode);
  const safeUnlockKey = escapeHtml(
    unlockKey?.trim() || "#"
  );
  const dateTimeZone =
    normalizePropertyTimeZone(propertyTimeZone);

  if (!resend) {
    if (isProd) {
      throw new Error(
        "RESEND_API_KEY missing in production"
      );
    }

    console.log(
      "RESEND_API_KEY missing. Guest access email fallback.",
      {
        to,
        reservationNumber,
      }
    );

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject:
        `${isSpanish ? "Su acceso Pin&Go está listo - Reservación" : "Your Pin&Go access is ready - Reservation"} #${reservationNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              ${isSpanish ? "Acceso seguro Pin&Go" : "Pin&Go Secure Access"}
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              ${isSpanish ? "Su acceso está listo" : "Your access is ready"}
            </h1>

            <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
              ${isSpanish ? "Reservación" : "Reservation"} #${safeReservationNumber}
            </p>
          </div>

          <p>${isSpanish ? "Hola" : "Hi"} ${safeGuestName},</p>

          <p>
            ${isSpanish ? "Su acceso temporal para" : "Your temporary access for"}
            <strong>${safePropertyName}</strong>
            ${isSpanish ? "está listo." : "is ready."}
          </p>

          <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:16px;padding:20px;margin:22px 0;text-align:center;">
            <p style="margin:0 0 8px;color:#475569;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
              ${isSpanish ? "Código de acceso" : "Access code"}
            </p>

            <p style="margin:0;font-size:34px;font-weight:800;letter-spacing:0.16em;color:#0f172a;">
              ${safePasscode}
            </p>
          </div>

          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;">
              <strong>${isSpanish ? "Válido desde" : "Valid from"}:</strong>
              ${formatBookingDateTime(
                validFrom,
                dateTimeZone,
                language
              )}
            </p>

            <p style="margin:0 0 8px;">
              <strong>${isSpanish ? "Válido hasta" : "Valid until"}:</strong>
              ${formatBookingDateTime(
                validUntil,
                dateTimeZone,
                language
              )}
            </p>

            <p style="margin:0;">
              ${isSpanish ? "Ingrese el código en el teclado y presione" : "Enter the code on the keypad and press"}
              <strong>${safeUnlockKey}</strong>
              ${isSpanish ? "para abrir." : "to unlock."}
            </p>
          </div>

          <p>
            ${isSpanish
              ? "Esta credencial es personal y no debe compartirse con personas que no estén incluidas en su reservación."
              : "This access credential is personal. Do not share it with anyone who is not included in your reservation."}
          </p>

          <p>
            Pin&Go
          </p>
        </div>
      `,
    });

  if (error) {
    throw new Error(
      `Resend guest access email failed: ${error.message}`
    );
  }

  console.log(
    "GUEST ACCESS EMAIL SENT",
    {
      to,
      reservationNumber,
    }
  );

  return {
    ok: true,
    mode: "resend",
    data,
  };
}

export type SendGuestVerificationReminderEmailInput = {
  to: string;
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;
  checkIn: Date;
  propertyTimeZone?: string | null;
  verificationUrl: string;
  preferredLanguage?: string | null;
};

export async function sendGuestVerificationReminderEmail(
  input: SendGuestVerificationReminderEmailInput
) {
  const {
    to,
    reservationNumber,
    guestName,
    propertyName,
    checkIn,
    propertyTimeZone,
    verificationUrl,
    preferredLanguage,
  } = input;
  const language = resolveGuestLanguage(preferredLanguage);
  const isSpanish = language === "es";

  const safeReservationNumber =
    escapeHtml(reservationNumber);

  const safeGuestName =
    escapeHtml(
      guestName?.trim() || (isSpanish ? "Huésped" : "Guest")
    );

  const safePropertyName =
    escapeHtml(propertyName);

  const normalizedVerificationUrl =
    getSafeUrl(verificationUrl);

  if (!normalizedVerificationUrl) {
    throw new Error(
      "Guest verification reminder URL is missing or invalid"
    );
  }

  const safeVerificationUrl =
    escapeHtml(normalizedVerificationUrl);

  const dateTimeZone =
    normalizePropertyTimeZone(
      propertyTimeZone
    );

  const formattedCheckIn =
    formatBookingDateTime(
      checkIn,
      dateTimeZone,
      language
    );

  if (!resend) {
    if (isProd) {
      throw new Error(
        "RESEND_API_KEY missing in production"
      );
    }

    console.log(
      "RESEND_API_KEY missing. Guest verification reminder fallback.",
      {
        to,
        reservationNumber,
      }
    );

    return {
      ok: true,
      mode: "console",
    };
  }

  const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject:
        `${isSpanish ? "Acción requerida - Reservación" : "Action required - Reservation"} #${reservationNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              Pin&amp;Go Guest Services
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              ${isSpanish ? "Registro seguro aún requerido" : "Secure pre-check-in still required"}
            </h1>

            <p style="margin:12px 0 0;color:#dbeafe;font-weight:700;">
              ${isSpanish ? "Reservación" : "Reservation"} #${safeReservationNumber}
            </p>
          </div>

          <p>
            ${isSpanish ? "Hola" : "Hi"} ${safeGuestName},
          </p>

          <p>
            ${isSpanish ? "Su estadía en" : "Your stay at"}
            <strong>${safePropertyName}</strong>
            ${isSpanish ? "se aproxima." : "is approaching."}
          </p>

          <p>
            ${isSpanish ? "Su check-in está programado para" : "Your scheduled check-in is"}:
            <strong>${escapeHtml(formattedCheckIn)}</strong>
          </p>

          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:20px;margin:22px 0;">
            <p style="margin:0 0 14px;color:#1e40af;">
              ${isSpanish
                ? "Complete la verificación de identidad, revise y acepte las reglas de la propiedad y la política de cancelación, y firme el acuerdo del huésped antes de que Pin&amp;Go pueda entregar su acceso digital."
                : "Complete identity verification, review and accept the property rules and cancellation policy, and sign the guest agreement before Pin&amp;Go can release your digital access."}
            </p>

            <p style="margin:0 0 18px;">
              <a
                href="${safeVerificationUrl}"
                style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 20px;border-radius:12px;font-weight:800;"
              >
                ${isSpanish ? "Completar registro seguro" : "Complete secure pre-check-in"}
              </a>
            </p>

            <p style="margin:0;color:#475569;font-size:13px;">
              ${isSpanish ? "Enlace seguro" : "Secure link"}:
              <br />
              <a
                href="${safeVerificationUrl}"
                style="color:#2563eb;word-break:break-all;"
              >
                ${safeVerificationUrl}
              </a>
            </p>
          </div>

          <p style="color:#475569;font-size:13px;">
            ${isSpanish
              ? "Este mensaje automático fue enviado por Pin&amp;Go Guest Services."
              : "This automated message was sent by Pin&amp;Go Guest Services."}
          </p>
        </div>
      `,
    });

  if (error) {
    throw new Error(
      `Guest verification reminder email failed: ${error.message}`
    );
  }

  return {
    ok: true,
    mode: "resend",
    data,
  };
}
