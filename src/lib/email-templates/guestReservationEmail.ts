import type { GuestLanguage } from "../../services/guest-language.service.js";

export type GuestReservationEmailMode =
  | "DIRECT_BOOKING"
  | "MANUAL";

export interface GuestReservationEmailInput {
  mode: GuestReservationEmailMode;
  pinAIEnabled?: boolean;
  reservationNumber: string;
  guestName?: string | null;
  propertyName: string;
  language: GuestLanguage;
  checkIn: string;
  checkOut: string;

  totalPaid?: string | null;
  paymentStatus?: string | null;

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
    badge: "Pin&amp;Go",

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
  const isSpanish = input.language === "es";
  const title = isSpanish ? copy.titleEs : copy.titleEn;
  const subtitle = isSpanish ? copy.subtitleEs : copy.subtitleEn;
  const badge = input.mode === "MANUAL"
    ? isSpanish
      ? "Reservaci&oacute;n Pin&amp;Go"
      : "Pin&amp;Go Reservation"
    : copy.badge;

  const reservationNumber =
    escapeHtml(
      input.reservationNumber
    );

  const propertyName =
    escapeHtml(
      input.propertyName
    );

  const guestName =
    escapeHtml(
      input.guestName?.trim() ||
        (isSpanish ? "Huésped" : "Guest")
    );

  const checkIn =
    escapeHtml(
      input.checkIn
    );

  const checkOut =
    escapeHtml(
      input.checkOut
    );

  const totalPaid =
    input.totalPaid
      ? escapeHtml(
          input.totalPaid
        )
      : null;

  const paymentStatus =
    input.paymentStatus
      ? escapeHtml(
          input.paymentStatus
        )
      : null;

  const paymentRows = `
    ${
      totalPaid
        ? renderDetailRow(
            isSpanish ? "Total pagado" : "Total paid",
            totalPaid
          )
        : ""
    }

    ${
      paymentStatus
        ? renderDetailRow(
            isSpanish ? "Estado del pago" : "Payment status",
            paymentStatus
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

    <html lang="${input.language}">
      <head>
        <meta charset="utf-8" />

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />

        <title>
          ${title}
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
          ${title}
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
              ${badge}
            </p>

            <h1
              style="
                margin:0;
                font-size:28px;
                line-height:1.15;
              "
            >
              ${title}
            </h1>

            <p
              style="
                margin:12px 0 0;
                color:#dbeafe;
                font-weight:700;
              "
            >
              ${isSpanish ? "Reservaci&oacute;n" : "Reservation"}
              #${reservationNumber}
            </p>

            <p
              style="
                margin:10px 0 0;
                color:#dbeafe;
              "
            >
              ${subtitle}
            </p>
          </div>

          <div
            lang="${input.language}"
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
              ${isSpanish ? "Espa&ntilde;ol" : "English"}
            </p>

            <p style="margin:0 0 14px;">
              ${isSpanish ? "Hola" : "Hello"} ${guestName},
            </p>

            <p style="margin:0 0 18px;">
              ${(isSpanish ? copy.introEs : copy.introEn)(
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
                isSpanish
                  ? "N&uacute;mero de reservaci&oacute;n"
                  : "Reservation number",
                `#${reservationNumber}`
              )}

              ${renderDetailRow(
                isSpanish ? "Propiedad" : "Property",
                propertyName
              )}

              ${renderDetailRow(
                isSpanish ? "Entrada" : "Check-in",
                checkIn
              )}

              ${renderDetailRow(
                isSpanish ? "Salida" : "Check-out",
                checkOut
              )}

              ${paymentRows}
            </table>

            <p
              style="
                margin:18px 0 0;
                color:#475569;
              "
            >
              <strong>
                ${isSpanish ? "Pr&oacute;ximo paso:" : "Next step:"}
              </strong>

              ${isSpanish ? copy.nextStepEs : copy.nextStepEn}
            </p>
          </div>

          ${verificationBlock}

          ${manageReservationBlock}

          ${input.mode === "DIRECT_BOOKING" && manageReservationBlock ? `
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:18px;margin:20px 0;color:#1e3a8a;">
            <h3 style="margin:0 0 8px;">${isSpanish ? "Tu estadía, paso a paso" : "Your stay, step by step"}</h3>
            <ol style="margin:0;padding-left:22px;">
              <li>${isSpanish
                ? "Guarda este correo y abre Administrar reservación para consultar los detalles y completar los requisitos de pre-check-in que correspondan a tu alojamiento."
                : "Keep this email and open Manage reservation to review your details and complete the pre-check-in requirements for your accommodation."}</li>
              <li>${isSpanish
                ? "Antes de llegar, revisa las instrucciones de acceso y los horarios de tu reserva. El acceso se habilita según los requisitos y la ventana de entrada; la confirmación por sí sola no permite entrar antes."
                : "Before arrival, review your access instructions and reservation times. Access is enabled according to the requirements and entry window; confirmation alone does not permit early entry."}</li>
              <li>${isSpanish
                ? "Durante tu estadía, usa Administrar reservación para consultar las opciones disponibles. Los cambios, cancelaciones y solicitudes de horarios dependen de disponibilidad, condiciones y posibles cargos. Espera su confirmación antes de dar un cambio por hecho."
                : "During your stay, use Manage reservation to review available options. Changes, cancellations, and time requests depend on availability, conditions, and possible charges. Wait for confirmation before treating a change as final."}</li>
              <li>${isSpanish
                ? "Antes de salir, revisa la hora de checkout y las instrucciones de tu alojamiento."
                : "Before leaving, review your checkout time and your accommodation’s departure instructions."}</li>
            </ol>
          </div>
          ${input.pinAIEnabled === true ? `
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin:20px 0;">
            <h3 style="margin:0 0 8px;">${isSpanish ? "Conoce Pin AI, el asistente de tu estadía" : "Meet Pin AI, your stay assistant"}</h3>
            <p style="margin:0 0 10px;">${isSpanish
              ? "Tu alojamiento tiene Pin AI activo. Abre Administrar reservación y busca el chat de Pin AI. Puedes usar este asistente de inteligencia artificial desde el navegador, sin instalar una app, y escribir en español o inglés."
              : "Your accommodation has Pin AI enabled. Open Manage reservation and find the Pin AI chat. You can use this AI assistant in your browser without installing an app, and write in English or Spanish."}</p>
            <p style="margin:0 0 10px;">${isSpanish
              ? "Puedes preguntar cómo acceder al alojamiento, cómo conectarte al Wi-Fi o qué hacer si la televisión no funciona. También puedes consultar si es posible solicitar una salida más tarde. Las respuestas dependen de la información proporcionada por el anfitrión."
              : "You can ask how to access the accommodation, how to connect to Wi-Fi, or what to do if the TV is not working. You can also ask whether a later checkout can be requested. Answers depend on information supplied by the host."}</p>
            <p style="margin:0 0 10px;">${isSpanish
              ? "Si reportas un problema, revisa la respuesta y las actualizaciones para saber si se ha avisado al anfitrión. Pin AI está disponible desde 24 horas antes de la entrada hasta 24 horas después de la salida. Si no aparece o necesitas ayuda fuera de ese período, utiliza el contacto de esta confirmación."
              : "If you report a problem, check the reply and updates to see whether the host has been notified. Pin AI is available from 24 hours before check-in until 24 hours after checkout. If it does not appear or you need help outside that period, use the contact in this confirmation."}</p>
            <p style="margin:0;font-size:13px;color:#475569;">${isSpanish
              ? "Tu enlace de reservación es privado. Evita compartirlo."
              : "Your reservation link is private. Avoid sharing it."}</p>
          </div>
          ` : ""}
          ` : ""}

          ${manageReservationBlock ? `
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:18px;margin:20px 0;color:#1e3a8a;">
            <h3 style="margin:0 0 8px;">Pin&amp;Go Guest</h3>
            <p>${isSpanish
              ? "Lleva tu reservación en tu teléfono. La app es opcional; su descarga pública para iPhone y Android estará disponible al completarse la aprobación en App Store y Google Play. Mientras tanto, puedes continuar en el navegador desde los enlaces seguros de este correo."
              : "Keep your reservation on your phone. The app is optional; public downloads for iPhone and Android will be available once App Store and Google Play approval is complete. Meanwhile, you can continue in your browser using this email’s secure links."}</p>
            <ol style="padding-left:22px;">
              <li>${isSpanish
                ? "Cuando esté publicada, descarga Pin&Go Guest desde App Store (iPhone) o Google Play (Android). Si ya está instalada, continúa."
                : "Once published, download Pin&Go Guest from the App Store (iPhone) or Google Play (Android). If already installed, continue."}</li>
              <li>${isSpanish
                ? "En ese mismo teléfono, abre el enlace de registro o acceso de tu reservación y selecciona Usar Pin&Go Guest. Solicita el código de verificación que recibirás en el correo de tu reservación y confirma el dispositivo. No es el PIN de la puerta."
                : "On that same phone, open your reservation’s registration or access link and select Use Pin&Go Guest. Request the verification code sent to your reservation email and confirm the device. This is not your door PIN."}</li>
              <li>${isSpanish
                ? "Pulsa Abrir en Pin&Go Guest para vincular la estadía. Consulta tu reserva en Stay, tu acceso y horario en Access y la ayuda en Help."
                : "Tap Open in Pin&Go Guest to link your stay. Review your reservation in Stay, entry details and times in Access, and assistance in Help."}</li>
              <li>${isSpanish
                ? "Si Access muestra una llave Bluetooth, activa Bluetooth, permite los permisos solicitados y acércate a la cerradura para abrir desde Access. La disponibilidad depende del alojamiento, del registro completo y del horario autorizado."
                : "If Access shows a Bluetooth key, turn on Bluetooth, allow requested permissions, and stand near the lock to unlock from Access. Availability depends on the accommodation, completed registration, and authorized times."}</li>
            </ol>
            <p style="margin-bottom:0;">${isSpanish
              ? "Guarda este correo y vuelve al enlace de tu reservación después de instalar la app. Si no abre, continúa en el navegador. No compartas enlaces privados, códigos de verificación ni credenciales de acceso."
              : "Keep this email and return to your reservation link after installing the app. If it does not open, continue in your browser. Do not share private links, verification codes, or access credentials."}</p>
          </div>
          ` : ""}

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
            <div lang="${input.language}">
              <h3
                style="
                  margin:0 0 8px;
                "
              >
                ${isSpanish ? "Acceso inteligente" : "Smart access"}
              </h3>

              <p style="margin:0;">
                ${isSpanish
                  ? "El acceso digital permanecer&aacute; protegido hasta completar los requisitos de registro seguro y las validaciones operacionales de la propiedad. Las instrucciones de acceso pueden enviarse m&aacute;s cerca de la entrada."
                  : "Digital access remains protected until the property's secure check-in requirements and operational checks are complete. Access instructions may be delivered closer to check-in."}
              </p>
            </div>
          </div>

          <!-- SIGNATURE -->

          <div
            lang="${input.language}"
            style="margin-top:24px;"
          >
            <p style="margin:0;">
              ${isSpanish ? "Gracias" : "Thank you"},<br />
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
            ${isSpanish
              ? "Este es un mensaje transaccional relacionado con su reservaci&oacute;n."
              : "This is a transactional message regarding your reservation."}
          </p>
        </div>
      </body>
    </html>
  `;
}
