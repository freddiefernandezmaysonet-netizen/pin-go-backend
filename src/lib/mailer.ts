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
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?: CancellationRefundRuleEmailInput[] | null;
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

function renderManageReservationBlock(
  manageReservationUrl?: string | null
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

  return `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:20px;margin:22px 0;">
      <h3 style="margin:0 0 8px;color:#1e3a8a;">
        Manage your reservation
      </h3>

      <h3 style="margin:0 0 14px;color:#1e40af;">
        Administre su reservaci&oacute;n
      </h3>

      <p style="margin:0 0 16px;color:#1e40af;">
        Review your stay details, cancellation terms, refund eligibility, and available self-service options.
        Revise los detalles de su estad&iacute;a, los t&eacute;rminos de cancelaci&oacute;n, la elegibilidad de reembolso y las opciones disponibles.
      </p>

      <p style="margin:0 0 18px;">
        <a
          href="${escapedUrl}"
          style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:800;"
        >
          Manage reservation / Administrar reservaci&oacute;n
        </a>
      </p>

      <p style="margin:0;color:#475569;font-size:13px;">
        Secure link / Enlace seguro:
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
}: {
  cancellationPolicyName?: string | null;
  cancellationPolicyType?: string | null;
  cancellationPolicySummary?: string | null;
  refundBasis?: string | null;
  refundRules?:
    | CancellationRefundRuleEmailInput[]
    | null;
}) {
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
      ? "Nightly subtotal only / Solo subtotal de noches"
      : refundBasis ===
        "NIGHTLY_PLUS_CLEANING"
      ? "Nightly subtotal and eligible cleaning fee / Noches y cargo de limpieza elegible"
      : refundBasis ===
        "TOTAL_AMOUNT"
      ? "Eligible total amount / Total elegible"
      : refundBasis
      ? `${formatRefundBasis(
          refundBasis
        )} / Seg\u00fan la base configurada`
      : null;

  return `
    <div style="background:#f8fafc;border:1px solid #dbeafe;border-radius:14px;padding:16px;margin:20px 0;">
      <h3 style="margin:0 0 8px;color:#111827;">
        Cancellation &amp; refund policy
      </h3>

      <h3 style="margin:0 0 12px;color:#374151;">
        Pol&iacute;tica de cancelaci&oacute;n y reembolso
      </h3>

      ${
        cancellationPolicyName ||
        cancellationPolicyType
          ? `
            <p style="margin:0 0 8px;">
              <strong>Policy / Pol&iacute;tica:</strong>
              ${escapeHtml(
                cancellationPolicyName ||
                  cancellationPolicyType ||
                  "Configured by host"
              )}
            </p>
          `
          : ""
      }

      ${
        refundBasisLabel
          ? `
            <p style="margin:0 0 8px;">
              <strong>Refund basis / Base del reembolso:</strong>
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
                Refund schedule / Calendario de reembolso
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
                        ${daysBeforeCheckIn}+ days before check-in /
                        ${daysBeforeCheckIn}+ d&iacute;as antes del check-in
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
              <p style="margin:0 0 8px;">
                Refund percentages apply only to the nightly subtotal. Cleaning fees, service fees, taxes, add-ons, and other non-nightly charges may not be refundable unless required by law or specifically stated in the policy.
              </p>

              <p style="margin:0;">
                Los porcentajes de reembolso aplican solamente al subtotal de noches. Los cargos de limpieza, servicio, impuestos, complementos y otros cargos que no correspondan a noches pueden no ser reembolsables, salvo que la ley o la pol&iacute;tica indiquen lo contrario.
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
    cancellationPolicyName,
    cancellationPolicyType,
    cancellationPolicySummary,
    refundBasis,
    refundRules,
  } = input;

  const safeReservationNumber = escapeHtml(reservationNumber);
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

   if (!manageReservationBlock) {
    throw new Error(
      "Direct booking manage reservation URL is missing or invalid"
    );
  }

  const cancellationPolicyBlock = renderCancellationPolicyBlock({
    cancellationPolicyName,
    cancellationPolicyType,
    cancellationPolicySummary,
    refundBasis,
    refundRules,
  });

    const { data, error } =
    await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject:
        `Reservation confirmed / Reservaci\u00f3n confirmada #${reservationNumber} - ${propertyName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              Pin&amp;Go Direct Booking
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              Your reservation is confirmed
            </h1>

            <h2 style="margin:8px 0 0;font-size:22px;line-height:1.2;">
              Su reservaci&oacute;n est&aacute; confirmada
            </h2>

            <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
              Reservation / Reservaci&oacute;n #${safeReservationNumber}
            </p>

            <p style="margin:8px 0 0;color:#dbeafe;">
              Pin&amp;Go has started the secure stay workflow.
              Pin&amp;Go ha iniciado el flujo seguro de estad&iacute;a.
            </p>
          </div>

          <p>
            Hi / Hola ${safeName},
          </p>

          <p>
            Your reservation for <strong>${safePropertyName}</strong> is confirmed and paid.
            Su reservaci&oacute;n para <strong>${safePropertyName}</strong> est&aacute; confirmada y pagada.
          </p>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
            <p>
              <strong>Reservation Number / N&uacute;mero de reservaci&oacute;n:</strong>
              #${safeReservationNumber}
            </p>

            <p>
              <strong>Property / Propiedad:</strong>
              ${safePropertyName}
            </p>

            <p>
              <strong>Check-in / Entrada:</strong>
              ${formatBookingDate(
                checkIn,
                dateTimeZone
              )}
            </p>

            <p>
              <strong>Check-out / Salida:</strong>
              ${formatBookingDate(
                checkOut,
                dateTimeZone
              )}
            </p>

            <p>
              <strong>Total paid / Total pagado:</strong>
              ${formatBookingAmount(
                totalAmount,
                currency
              )}
            </p>

            <p>
              <strong>Payment status / Estado del pago:</strong>
              Paid / Pagado
            </p>
          </div>

          ${manageReservationBlock}

          ${cancellationPolicyBlock}

          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:16px;margin:20px 0;color:#92400e;">
            <h3 style="margin:0 0 8px;">
              Secure pre-check-in / Registro seguro
            </h3>

            <p style="margin:0 0 10px;">
              Complete identity verification, review the property rules, and sign the guest agreement before digital access is released.
            </p>

            <p style="margin:0;">
              Complete la verificaci&oacute;n de identidad, revise las reglas de la propiedad y firme el acuerdo del hu&eacute;sped antes de recibir el acceso digital.
            </p>
          </div>

          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin:20px 0;color:#14532d;">
            <h3 style="margin:0 0 8px;">
              Smart access / Acceso inteligente
            </h3>

            <p style="margin:0 0 10px;">
              Your smart-access instructions will be delivered according to the property&apos;s secure check-in workflow. Access details may be sent closer to check-in after operational checks are complete.
            </p>

            <p style="margin:0;">
              Las instrucciones de acceso inteligente se entregar&aacute;n seg&uacute;n el flujo seguro de check-in de la propiedad. Los detalles pueden enviarse m&aacute;s cerca del check-in, despu&eacute;s de completar las validaciones operacionales.
            </p>
          </div>

          <p style="color:#4b5563;">
            Use the Manage Reservation link to review stay details, cancellation terms, refund eligibility, and available self-service options.
            Utilice el enlace Administrar reservaci&oacute;n para revisar la estad&iacute;a, los t&eacute;rminos de cancelaci&oacute;n, la elegibilidad de reembolso y las opciones disponibles.
          </p>

          <p>
            Thank you / Gracias,<br />
            Pin&amp;Go
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;" />

          <p style="color:#6b7280;font-size:12px;">
            This is a transactional message regarding your reservation.
            Este es un mensaje transaccional relacionado con su reservaci&oacute;n.
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
    reservationNumber,
    guestName,
    propertyName,
    checkIn,
    checkOut,
    propertyTimeZone,
    verificationUrl,
  } = input;

  const safeReservationNumber =
    escapeHtml(reservationNumber);

  const safeName = escapeHtml(
    guestName?.trim() || "there"
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
        Secure pre-check-in required
      </h2>

      <h3 style="margin:0 0 14px;color:#1e40af;">
        Registro seguro requerido
      </h3>

      <p style="margin:0 0 10px;color:#1e40af;">
        Before Pin&amp;Go releases your digital access, complete identity verification, review and accept the property rules and cancellation/refund policy, and sign the guest agreement.
      </p>

      <p style="margin:0 0 16px;color:#1e40af;">
        Antes de que Pin&amp;Go entregue su acceso digital, complete la verificaci&oacute;n de identidad, revise y acepte las reglas de la propiedad y la pol&iacute;tica de cancelaci&oacute;n/reembolso, y firme el acuerdo del hu&eacute;sped.
      </p>

      <p style="margin:0 0 18px;">
        <a
          href="${safeVerificationUrl}"
          style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:800;"
        >
          Complete secure pre-check-in / Complete el registro seguro
        </a>
      </p>

      <p style="margin:0;color:#475569;font-size:13px;">
        Secure link / Enlace seguro:
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
        `Reservation / Reservaci\u00f3n #${reservationNumber} - Secure pre-check-in required - ${propertyName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              Pin&amp;Go Reservation / Reservaci&oacute;n
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              Reservation created
            </h1>

            <h2 style="margin:8px 0 0;font-size:22px;line-height:1.2;">
              Reservaci&oacute;n creada
            </h2>

            <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
              Reservation / Reservaci&oacute;n #${safeReservationNumber}
            </p>

            <p style="margin:8px 0 0;color:#dbeafe;">
              Secure pre-check-in must be completed before digital access can be released.
              Debe completar el registro seguro antes de recibir el acceso digital.
            </p>
          </div>

          <p>
            Hi / Hola ${safeName},
          </p>

          <p>
            Your reservation for <strong>${safePropertyName}</strong> has been created.
            Su reservaci&oacute;n para <strong>${safePropertyName}</strong> ha sido creada.
          </p>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
            <p>
              <strong>Reservation Number / N&uacute;mero de reservaci&oacute;n:</strong>
              #${safeReservationNumber}
            </p>

            <p>
              <strong>Property / Propiedad:</strong>
              ${safePropertyName}
            </p>

            <p>
              <strong>Check-in / Entrada:</strong>
              ${formatBookingDate(
                checkIn,
                dateTimeZone
              )}
            </p>

            <p>
              <strong>Check-out / Salida:</strong>
              ${formatBookingDate(
                checkOut,
                dateTimeZone
              )}
            </p>
          </div>

          ${verificationBlock}

          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:16px;margin:20px 0;color:#92400e;">
            <h3 style="margin:0 0 8px;">
              Required steps / Pasos requeridos
            </h3>

            <ul style="margin:0;padding-left:22px;">
              <li>
                Identity verification / Verificaci&oacute;n de identidad
              </li>
              <li>
                Guest agreement and property rules / Acuerdo del hu&eacute;sped y reglas de la propiedad
              </li>
              <li>
                Cancellation and refund policy acceptance / Aceptaci&oacute;n de la pol&iacute;tica de cancelaci&oacute;n y reembolso
              </li>
            </ul>

            <p style="margin:12px 0 0;">
              SMS updates are optional and are not required to complete the reservation.
              Las actualizaciones por SMS son opcionales y no son necesarias para completar la reservaci&oacute;n.
            </p>
          </div>

          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin:20px 0;color:#14532d;">
            <h3 style="margin:0 0 8px;">
              Smart access / Acceso inteligente
            </h3>

            <p style="margin:0 0 10px;">
              Digital access remains protected until the secure pre-check-in requirements are completed. Access instructions may be delivered closer to check-in after operational checks are complete.
            </p>

            <p style="margin:0;">
              El acceso digital permanecer&aacute; protegido hasta completar los requisitos del registro seguro. Las instrucciones de acceso pueden enviarse m&aacute;s cerca del check-in, despu&eacute;s de completar las validaciones operacionales.
            </p>
          </div>

          <p>
            Thank you / Gracias,<br />
            Pin&amp;Go
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;" />

          <p style="color:#6b7280;font-size:12px;">
            This is a transactional message regarding your reservation.
            Este es un mensaje transaccional relacionado con su reservaci&oacute;n.
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
  } = input;

  const safeReservationNumber = escapeHtml(reservationNumber);
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
    subject: `${title} - Reservation #${reservationNumber} - ${propertyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6; max-width: 680px; margin: 0 auto;">
       <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">Pin&Go Cancellation Update</p>
  <h1 style="margin:0;font-size:28px;line-height:1.15;">${escapeHtml(title)}</h1>
  <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">Reservation #${safeReservationNumber}</p>
  <p style="margin:8px 0 0;color:#dbeafe;">${escapeHtml(body)}</p>
</div>
        <p>Hi ${safeName},</p>

        <p>
          Your reservation for <strong>${safePropertyName}</strong> has been cancelled.
        </p>

        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:20px 0;">
  <p><strong>Reservation Number:</strong> #${safeReservationNumber}</p>
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

<p><strong>Número de reservación:</strong> #${safeReservationNumber}</p>

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
  } = input;

  const safeReservationNumber =
    escapeHtml(reservationNumber);
  const safeGuestName = escapeHtml(
    guestName?.trim() || "Guest"
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
        `Your Pin&Go access is ready - Reservation #${reservationNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;max-width:680px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#020617,#1d4ed8);color:#ffffff;border-radius:18px;padding:24px;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">
              Pin&Go Secure Access
            </p>

            <h1 style="margin:0;font-size:28px;line-height:1.15;">
              Your access is ready
            </h1>

            <p style="margin:10px 0 0;color:#dbeafe;font-weight:700;">
              Reservation #${safeReservationNumber}
            </p>
          </div>

          <p>Hi ${safeGuestName},</p>

          <p>
            Your temporary access for
            <strong>${safePropertyName}</strong>
            is ready.
          </p>

          <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:16px;padding:20px;margin:22px 0;text-align:center;">
            <p style="margin:0 0 8px;color:#475569;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
              Access code
            </p>

            <p style="margin:0;font-size:34px;font-weight:800;letter-spacing:0.16em;color:#0f172a;">
              ${safePasscode}
            </p>
          </div>

          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;">
              <strong>Valid from:</strong>
              ${formatBookingDateTime(
                validFrom,
                dateTimeZone
              )}
            </p>

            <p style="margin:0 0 8px;">
              <strong>Valid until:</strong>
              ${formatBookingDateTime(
                validUntil,
                dateTimeZone
              )}
            </p>

            <p style="margin:0;">
              Enter the code on the keypad and press
              <strong>${safeUnlockKey}</strong>
              to unlock.
            </p>
          </div>

          <p>
            This access credential is personal. Do not
            share it with anyone who is not included in
            your reservation.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;" />

          <h2 style="margin-bottom:8px;">
            Su acceso está listo
          </h2>

          <p>Hola ${safeGuestName},</p>

          <p>
            Su código temporal para
            <strong>${safePropertyName}</strong>
            es:
          </p>

          <p style="font-size:30px;font-weight:800;letter-spacing:0.14em;color:#0f172a;">
            ${safePasscode}
          </p>

          <p>
            Ingrese el código en el teclado y presione
            <strong>${safeUnlockKey}</strong>
            para abrir.
          </p>

          <p>
            Esta credencial es personal y no debe
            compartirse con personas que no estén
            incluidas en su reservación.
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