export type GuestReservationEmailMode =
  | "DIRECT_BOOKING"
  | "MANUAL";

export interface GuestReservationEmailInput {
  mode: GuestReservationEmailMode;
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;

  checkInEn: string;
  checkInEs: string;
  checkOutEn: string;
  checkOutEs: string;

  totalPaid?: string | null;
  paymentStatusEn?: string | null;
  paymentStatusEs?: string | null;

  /**
   * Estos bloques deben ser generados internamente por Pin&Go.
   * Se insertan como HTML confiable y nunca deben recibir
   * directamente contenido escrito por el huésped.
   */
  manageReservationBlock?: string;
  verificationBlock?: string;
  cancellationPolicyBlock?: string;
}

type EmailCopy = {
  badge: string;
  titleEn: string;
  titleEs: string;
  subtitleEn: string;
  subtitleEs: string;
  introEn: (propertyName: string) => string;
  introEs: (propertyName: string) => string;
  nextStepEn: string;
  nextStepEs: string;
};

const EMAIL_COPY: Record<
  GuestReservationEmailMode,
  EmailCopy
> = {
  DIRECT_BOOKING: {
    badge: "Pin&amp;Go Direct Booking",

    titleEn:
      "Your reservation is confirmed",

    titleEs:
      "Su reservaci&oacute;n est&aacute; confirmada",

    subtitleEn:
      "Pin&amp;Go has started the secure stay workflow.",

    subtitleEs:
      "Pin&amp;Go ha iniciado el proceso seguro de su estad&iacute;a.",

    introEn: (propertyName) =>
      `Your reservation for <strong>${propertyName}</strong> is confirmed and paid.`,

    introEs: (propertyName) =>
      `Su reservaci&oacute;n para <strong>${propertyName}</strong> est&aacute; confirmada y pagada.`,

    nextStepEn:
      "Review your reservation details and complete any secure pre-check-in requirements before arrival.",

    nextStepEs:
      "Revise los detalles de su reservaci&oacute;n y complete cualquier requisito de registro seguro antes de su llegada.",
  },

  MANUAL: {
    badge:
      "Pin&amp;Go Reservation / Reservaci&oacute;n",

    titleEn:
      "Your reservation was created",

    titleEs:
      "Su reservaci&oacute;n fue creada",

    subtitleEn:
      "Secure pre-check-in must be completed before digital access can be released.",

    subtitleEs:
      "Debe completar el registro seguro antes de que se pueda entregar el acceso digital.",

    introEn: (propertyName) =>
      `Your host created a reservation for you at <strong>${propertyName}</strong>.`,

    introEs: (propertyName) =>
      `Su anfitri&oacute;n cre&oacute; una reservaci&oacute;n para usted en <strong>${propertyName}</strong>.`,

    nextStepEn:
      "Complete the secure pre-check-in steps using the link included in this email.",

    nextStepEs:
      "Complete los pasos del registro seguro mediante el enlace incluido en este correo electr&oacute;nico.",
  },
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function trustedHtml(
  value?: string
): string {
  return String(value ?? "").trim();
}

function renderDetailRow(
  label: string,
  value: string
): string {
  return `
    <tr>
      <td
        style="
          padding:9px 12px 9px 0;
          color:#475569;
          font-size:14px;
          vertical-align:top;
        "
      >
        ${label}
      </td>

      <td
        style="
          padding:9px 0;
          color:#0f172a;
          font-size:14px;
          font-weight:700;
          text-align:right;
          vertical-align:top;
        "
      >
        ${value}
      </td>
    </tr>
  `;
}

export function buildGuestReservationEmail(
  input: GuestReservationEmailInput
): string {
  const copy =
    EMAIL_COPY[input.mode];

  const reservationNumber =
    escapeHtml(
      input.reservationNumber
    );

  const propertyName =
    escapeHtml(
      input.propertyName
    );

  const guestNameEn =
    escapeHtml(
      input.guestName?.trim() ||
        "Guest"
    );

  const guestNameEs =
    escapeHtml(
      input.guestName?.trim() ||
        "Huésped"
    );

  const checkInEn =
    escapeHtml(
      input.checkInEn
    );

  const checkInEs =
    escapeHtml(
      input.checkInEs
    );

  const checkOutEn =
    escapeHtml(
      input.checkOutEn
    );

  const checkOutEs =
    escapeHtml(
      input.checkOutEs
    );

  const totalPaid =
    input.totalPaid
      ? escapeHtml(
          input.totalPaid
        )
      : null;

  const paymentStatusEn =
    input.paymentStatusEn
      ? escapeHtml(
          input.paymentStatusEn
        )
      : null;

  const paymentStatusEs =
    input.paymentStatusEs
      ? escapeHtml(
          input.paymentStatusEs
        )
      : null;

  const paymentRowsEn = `
    ${
      totalPaid
        ? renderDetailRow(
            "Total paid",
            totalPaid
          )
        : ""
    }

    ${
      paymentStatusEn
        ? renderDetailRow(
            "Payment status",
            paymentStatusEn
          )
        : ""
    }
  `;

  const paymentRowsEs = `
    ${
      totalPaid
        ? renderDetailRow(
            "Total pagado",
            totalPaid
          )
        : ""
    }

    ${
      paymentStatusEs
        ? renderDetailRow(
            "Estado del pago",
            paymentStatusEs
          )
        : ""
    }
  `;

  const verificationBlock =
    trustedHtml(
      input.verificationBlock
    );

  const manageReservationBlock =
    trustedHtml(
      input.manageReservationBlock
    );

  const cancellationPolicyBlock =
    trustedHtml(
      input.cancellationPolicyBlock
    );

  return `
    <!doctype html>

    <html lang="en">
      <head>
        <meta charset="utf-8" />

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />

        <title>
          ${copy.titleEn} |
          ${copy.titleEs}
        </title>
      </head>

      <body
        style="
          margin:0;
          padding:0;
          background:#f8fafc;
        "
      >
        <div
          style="
            display:none;
            max-height:0;
            overflow:hidden;
            opacity:0;
            color:transparent;
          "
        >
          ${copy.titleEn} /
          ${copy.titleEs}
          #${reservationNumber}
        </div>

        <div
          style="
            font-family:Arial,sans-serif;
            color:#111827;
            line-height:1.6;
            max-width:680px;
            margin:0 auto;
            padding:24px 14px;
          "
        >
          <div
            style="
              background:linear-gradient(
                135deg,
                #020617,
                #1d4ed8
              );
              color:#ffffff;
              border-radius:18px;
              padding:24px;
              margin-bottom:20px;
            "
          >
            <p
              style="
                margin:0 0 8px;
                font-size:12px;
                letter-spacing:0.08em;
                text-transform:uppercase;
                font-weight:800;
              "
            >
              ${copy.badge}
            </p>

            <h1
              style="
                margin:0;
                font-size:28px;
                line-height:1.15;
              "
            >
              ${copy.titleEn}
            </h1>

            <h2
              style="
                margin:8px 0 0;
                font-size:22px;
                line-height:1.2;
              "
            >
              ${copy.titleEs}
            </h2>

            <p
              style="
                margin:12px 0 0;
                color:#dbeafe;
                font-weight:700;
              "
            >
              Reservation /
              Reservaci&oacute;n
              #${reservationNumber}
            </p>

            <p
              style="
                margin:10px 0 0;
                color:#dbeafe;
              "
            >
              ${copy.subtitleEn}
            </p>

            <p
              style="
                margin:4px 0 0;
                color:#dbeafe;
              "
            >
              ${copy.subtitleEs}
            </p>
          </div>

          <!-- ENGLISH -->

          <div
            lang="en"
            style="
              background:#ffffff;
              border:1px solid #e2e8f0;
              border-radius:16px;
              padding:20px;
              margin:20px 0;
            "
          >
            <p
              style="
                margin:0 0 6px;
                color:#2563eb;
                font-size:12px;
                font-weight:800;
                letter-spacing:0.08em;
                text-transform:uppercase;
              "
            >
              English
            </p>

            <p style="margin:0 0 14px;">
              Hello ${guestNameEn},
            </p>

            <p style="margin:0 0 18px;">
              ${copy.introEn(
                propertyName
              )}
            </p>

            <table
              role="presentation"
              width="100%"
              cellspacing="0"
              cellpadding="0"
              style="
                border-collapse:collapse;
                background:#f8fafc;
                border:1px solid #e2e8f0;
                border-radius:12px;
              "
            >
              ${renderDetailRow(
                "Reservation number",
                `#${reservationNumber}`
              )}

              ${renderDetailRow(
                "Property",
                propertyName
              )}

              ${renderDetailRow(
                "Check-in",
                checkInEn
              )}

              ${renderDetailRow(
                "Check-out",
                checkOutEn
              )}

              ${paymentRowsEn}
            </table>

            <p
              style="
                margin:18px 0 0;
                color:#475569;
              "
            >
              <strong>
                Next step:
              </strong>

              ${copy.nextStepEn}
            </p>
          </div>

          <!-- ESPAÑOL -->

          <div
            lang="es"
            style="
              background:#ffffff;
              border:1px solid #e2e8f0;
              border-radius:16px;
              padding:20px;
              margin:20px 0;
            "
          >
            <p
              style="
                margin:0 0 6px;
                color:#2563eb;
                font-size:12px;
                font-weight:800;
                letter-spacing:0.08em;
                text-transform:uppercase;
              "
            >
              Espa&ntilde;ol
            </p>

            <p style="margin:0 0 14px;">
              Hola ${guestNameEs},
            </p>

            <p style="margin:0 0 18px;">
              ${copy.introEs(
                propertyName
              )}
            </p>

            <table
              role="presentation"
              width="100%"
              cellspacing="0"
              cellpadding="0"
              style="
                border-collapse:collapse;
                background:#f8fafc;
                border:1px solid #e2e8f0;
                border-radius:12px;
              "
            >
              ${renderDetailRow(
                "N&uacute;mero de reservaci&oacute;n",
                `#${reservationNumber}`
              )}

              ${renderDetailRow(
                "Propiedad",
                propertyName
              )}

              ${renderDetailRow(
                "Entrada",
                checkInEs
              )}

              ${renderDetailRow(
                "Salida",
                checkOutEs
              )}

              ${paymentRowsEs}
            </table>

            <p
              style="
                margin:18px 0 0;
                color:#475569;
              "
            >
              <strong>
                Pr&oacute;ximo paso:
              </strong>

              ${copy.nextStepEs}
            </p>
          </div>

          ${verificationBlock}

          ${manageReservationBlock}

          ${cancellationPolicyBlock}

          <!-- SMART ACCESS -->

          <div
            style="
              background:#f0fdf4;
              border:1px solid #bbf7d0;
              border-radius:14px;
              padding:18px;
              margin:20px 0;
              color:#14532d;
            "
          >
            <div lang="en">
              <h3
                style="
                  margin:0 0 8px;
                "
              >
                Smart access
              </h3>

              <p style="margin:0;">
                Digital access remains
                protected until the
                property's secure check-in
                requirements and operational
                checks are complete. Access
                instructions may be delivered
                closer to check-in.
              </p>
            </div>

            <hr
              style="
                border:none;
                border-top:1px solid #bbf7d0;
                margin:16px 0;
              "
            />

            <div lang="es">
              <h3
                style="
                  margin:0 0 8px;
                "
              >
                Acceso inteligente
              </h3>

              <p style="margin:0;">
                El acceso digital permanecer&aacute;
                protegido hasta completar los
                requisitos de registro seguro y
                las validaciones operacionales
                de la propiedad. Las instrucciones
                de acceso pueden enviarse m&aacute;s
                cerca de la entrada.
              </p>
            </div>
          </div>

          <!-- SIGNATURE -->

          <div
            lang="en"
            style="margin-top:24px;"
          >
            <p style="margin:0;">
              Thank you,<br />
              Pin&amp;Go
            </p>
          </div>

          <div
            lang="es"
            style="margin-top:18px;"
          >
            <p style="margin:0;">
              Gracias,<br />
              Pin&amp;Go
            </p>
          </div>

          <hr
            style="
              border:none;
              border-top:1px solid #e5e7eb;
              margin:28px 0;
            "
          />

          <p
            style="
              margin:0;
              color:#6b7280;
              font-size:12px;
            "
          >
            This is a transactional message
            regarding your reservation.

            <br />

            Este es un mensaje transaccional
            relacionado con su reservaci&oacute;n.
          </p>
        </div>
      </body>
    </html>
  `;
}