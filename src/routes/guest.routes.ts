import {
  Router,
  type Request,
} from "express";
import { PrismaClient, AccessGrantType, AccessStatus } from "@prisma/client";
import {
  completeGuestAgreementAndStartIdentity,
} from "../services/guest-verification-flow.service";
import {
  evaluateGuestAccessReadiness,
} from "../services/guest-access-readiness.service";
import {
  ensureReservationGuestAgreementSnapshot,
} from "../services/guest-agreement.service";
import {
  renderCancellationPolicySnapshot,
  type CancellationPolicySnapshot,
} from "../services/cancellation-policy.service";

import type {
  RenderedCancellationPolicy,
} from "../services/cancellation-policy-renderer";

/* =====================
   Utils
===================== */
function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

type GuestLanguage = "en" | "es";

function resolveGuestLanguage(
  value: string | null | undefined
): GuestLanguage {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  return normalized === "es" ||
    normalized.startsWith("es-")
    ? "es"
    : "en";
}

function fmtLocal(
  d: Date,
  timeZone?: string | null
) {
  const normalizedTimeZone =
    String(timeZone ?? "").trim() ||
    "UTC";

  try {
    return new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          normalizedTimeZone,
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }
    ).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "UTC",
        month: "numeric",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }
    ).format(new Date(d));
  }
}

type GuestAgreementSnapshotView = {
  agreementId: string;
  version: string;
  title: string;
  agreementText: string;
  rules: unknown;
  guestFacingSummary: string | null;
  requiresIdentityVerification: boolean;
};

function readGuestAgreementSnapshot(
  value: unknown
): GuestAgreementSnapshotView | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  const snapshot = value as Record<string, unknown>;

  if (
    typeof snapshot.agreementId !== "string" ||
    typeof snapshot.version !== "string" ||
    typeof snapshot.title !== "string" ||
    typeof snapshot.agreementText !== "string"
  ) {
    return null;
  }

  return {
    agreementId: snapshot.agreementId,
    version: snapshot.version,
    title: snapshot.title,
    agreementText: snapshot.agreementText,
    rules: snapshot.rules ?? null,
    guestFacingSummary:
      typeof snapshot.guestFacingSummary === "string"
        ? snapshot.guestFacingSummary
        : null,
    requiresIdentityVerification:
      snapshot.requiresIdentityVerification !== false,
  };
}

function renderMultilineText(value: string) {
  return escapeHtml(value).replace(
    /\r?\n/g,
    "<br />"
  );
}

function ruleToText(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const rule = value as Record<string, unknown>;

    const title =
      typeof rule.title === "string"
        ? rule.title.trim()
        : "";

    const text =
      typeof rule.text === "string"
        ? rule.text.trim()
        : typeof rule.description === "string"
        ? rule.description.trim()
        : typeof rule.label === "string"
        ? rule.label.trim()
        : "";

    return [title, text]
      .filter(Boolean)
      .join(": ");
  }

  return "";
}

function renderAgreementRules(
  rules: unknown,
  language: GuestLanguage
) {
  const items = Array.isArray(rules)
    ? rules
        .map(ruleToText)
        .filter(Boolean)
    : rules &&
      typeof rules === "object"
    ? Object.values(
        rules as Record<string, unknown>
      )
        .map(ruleToText)
        .filter(Boolean)
    : [ruleToText(rules)].filter(Boolean);

  if (items.length === 0) {
    return `
      <p class="muted">
        ${
          language === "es"
            ? "No hay reglas adicionales fuera del acuerdo."
            : "There are no additional rules outside the agreement."
        }
      </p>
    `;
  }

  return `
    <ul class="rules">
      ${items
        .map(
          (rule) =>
            `<li>${escapeHtml(rule)}</li>`
        )
        .join("")}
    </ul>
  `;
}

type CancellationPolicyView = {
  presentation: RenderedCancellationPolicy;
  cancellationAccepted: boolean;
};

function readJsonObject(
  value: unknown
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Record<
    string,
    unknown
  >;
}

function readCancellationPolicyView(
  value: unknown,
  preferredLanguage: GuestLanguage,
  checkIn: Date
): CancellationPolicyView | null {
  const snapshot = readJsonObject(value);

  if (
    typeof snapshot.name !== "string" ||
    typeof snapshot.type !== "string" ||
    typeof snapshot.refundBasis !== "string"
  ) {
    return null;
  }

  const acceptance = readJsonObject(
    snapshot.cancellationTermsAcceptance
  );

  try {
    return {
      presentation: renderCancellationPolicySnapshot({
        snapshot: snapshot as unknown as CancellationPolicySnapshot,
        preferredLanguage,
        checkIn,
      }),
      cancellationAccepted: acceptance.accepted === true,
    };
  } catch (error) {
    console.error(
      "[GUEST_VERIFICATION] cancellation policy render failed",
      error
    );

    return null;
  }
}

function hasRecordedSmsConsent(
  externalRaw: unknown
) {
  const raw =
    readJsonObject(externalRaw);

  const consent =
    readJsonObject(raw.consent);

  return consent.smsConsent === true;
}

function renderCancellationRefundRules(
  rules: RenderedCancellationPolicy["rules"]
) {
  if (rules.length === 0) {
    return "";
  }

  const items = rules
    .map(
      (rule) => `
        <li>
          <strong>${escapeHtml(
            rule.label
          )}</strong>
          — ${escapeHtml(
            rule.windowLabel
          )}

          <p class="muted small">
            ${escapeHtml(
              rule.description
            )}
          </p>
        </li>
      `
    )
    .join("");

  return `<ul class="rules">${items}</ul>`;
}

function getGuestReturnUrl(
  req: Request,
  token: string
) {
  const configuredBase = String(
    process.env.PUBLIC_API_BASE_URL ??
      process.env.API_BASE_URL ??
      ""
  ).trim();

  let baseUrl: URL;

  if (configuredBase) {
    baseUrl = new URL(configuredBase);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PUBLIC_API_BASE_URL_MISSING"
      );
    }

    const host = req.get("host");

    if (!host) {
      throw new Error(
        "GUEST_VERIFICATION_HOST_MISSING"
      );
    }

    baseUrl = new URL(
      `${req.protocol}://${host}`
    );
  }

  return new URL(
    `/guest/verify/${encodeURIComponent(token)}?identity=returned`,
    baseUrl
  ).toString();
}

function getRequestIp(req: Request) {
  const forwarded = String(
    req.headers["x-forwarded-for"] ?? ""
  )
    .split(",")[0]
    ?.trim();

  return (
    forwarded ||
    req.socket.remoteAddress ||
    null
  );
}

function autoRefreshScript(enabled: boolean) {
  if (!enabled) return "";

  return `
<script>
(function () {
  var seconds = 10;
  var triesLeft = 12; // 12 * 10s = 120s
  var el = document.getElementById("autorefresh");

  function tick() {
    if (!el) return;
    el.textContent = "Actualizando en " + seconds + "s… (" + triesLeft + " intentos)";
    seconds--;

    if (seconds < 0) {
      triesLeft--;
      if (triesLeft <= 0) {
        el.textContent = "Auto-actualización detenida. Si no se activa, contacta al host.";
        return;
      }
      location.reload();
    } else {
      setTimeout(tick, 1000);
    }
  }

  tick();
})();
</script>`;
}

/* =====================
   Router
===================== */
export function buildGuestRouter(prisma: PrismaClient) {
  const router = Router();

  // ✅ Canonical: /guest/:token
  router.get("/guest/:token", async (req, res) => {
    try {
      const token = String(req.params.token ?? "").trim();
      const now = new Date();

      if (!token) {
        return res.status(400).type("html").send(
          renderPage({
            title: "Pin&Go • Acceso",
            badge: { text: "⚠️ Token requerido", tone: "bad" },
            body: `<p class="muted">Falta el token de acceso.</p>`,
          })
        );
      }

      const reservation = await prisma.reservation.findFirst({
        where: {
          guestToken: token,
          guestTokenExpiresAt: { gt: now },
        },
        include: {
          property: true,
          accessGrants: {
            where: { type: AccessGrantType.GUEST },
            orderBy: { startsAt: "asc" },
            include: { lock: true },
          },
        },
      });

      // Token inválido o expirado
      if (!reservation) {
        return res.status(404).type("html").send(
          renderPage({
            title: "Pin&Go • Acceso",
            badge: { text: "⛔ No disponible", tone: "bad" },
            body: `
              <h1>Link inválido o expirado</h1>
              <p class="muted">Este enlace no es válido o ya expiró.</p>
              <p class="muted">Si necesitas ayuda, contacta al host.</p>
            `,
          })
        );
      }

      const grants = reservation.accessGrants ?? [];
      const active = grants.find((g) => g.status === AccessStatus.ACTIVE) ?? null;
      const pending = grants.find((g) => g.status === AccessStatus.PENDING) ?? null;
      const revoked = grants.find((g) => g.status === AccessStatus.REVOKED) ?? null;

      const checkIn = reservation.checkIn;
      const checkOut = reservation.checkOut;

      // ✅ Auto-refresh SOLO cuando:
      // - existe grant PENDING
      // - ya estamos dentro de la ventana
      // - no ha pasado el checkout
      const shouldAutoRefresh = !!pending && now >= pending.startsAt && now < checkOut;

      const lockName =
        active?.lock?.ttlockLockName ??
        pending?.lock?.ttlockLockName ??
        revoked?.lock?.ttlockLockName ??
        "Puerta";

      let badge: { text: string; tone: "good" | "warn" | "bad" } = {
        text: "⏳ Preparando",
        tone: "warn",
      };
      let headline = "Tu acceso se está preparando";
      let bodyHtml = "";

      // ⛔ Expirado (por fecha)
      if (now >= checkOut) {
        badge = { text: "⛔ Expirado", tone: "bad" };
        headline = "Este acceso ya expiró";
        bodyHtml = `
          <div class="card">
            <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
            <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            <div class="row"><span class="k">Check-out</span><span class="v">${escapeHtml(fmtLocal(
  checkOut,
  reservation.property?.timezone
))}</span></div>
          </div>
          <p class="muted">Si necesitas extender el acceso, contacta al host.</p>
        `;
      }

      // 🔓 Activo
      else if (active) {
        badge = { text: "🔓 Activo", tone: "good" };
        headline = "Tu acceso está activo";
        bodyHtml = `
          <div class="card">
            <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
            <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            <div class="row"><span class="k">Válido hasta</span><span class="v">${escapeHtml(
  fmtLocal(
    active.endsAt,
    reservation.property?.timezone
  )
)}</span></div>
          </div>

          <div class="card">
            <div class="row">
              <span class="k">Código</span>
              <span class="v code">${escapeHtml(active.accessCodeMasked ?? "Enviado por mensaje")}</span>
            </div>
            <p class="muted small">Por seguridad el código completo no se muestra aquí.</p>
          </div>
        `;
      }

      // ⏳ Pendiente
      else if (pending) {
        badge = { text: "⏳ Pendiente", tone: "warn" };

        if (now < pending.startsAt) {
          headline = "Tu acceso se activará en el check-in";
          bodyHtml = `
            <div class="card">
              <div class="row"><span class="k">Check-in</span><span class="v">${escapeHtml(
  fmtLocal(
    checkIn,
    reservation.property?.timezone
  )
)}</span></div>
              <div class="row"><span class="k">Check-out</span><span class="v">${escapeHtml(fmtLocal(
  checkOut,
  reservation.property?.timezone
))}</span></div>
            </div>
            <p class="muted">Vuelve a abrir este enlace cerca del check-in.</p>
          `;
        } else {
          headline = "Estamos activando tu acceso";
          bodyHtml = `
            <div class="card">
              <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
              <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            </div>

            <div class="card">
              <div class="row">
                <span class="k">Estado</span>
                <span class="v"><span id="autorefresh" class="muted">Auto-actualizando…</span></span>
              </div>
            </div>

            <p class="muted">Esto suele tardar menos de 1 minuto.</p>
          `;
        }
      }

      // ⛔ Revocado
      else if (revoked) {
        badge = { text: "⛔ Revocado", tone: "bad" };
        headline = "Este acceso fue revocado";
        bodyHtml = `<p class="muted">Contacta al host si crees que es un error.</p>`;
      }

      // Sin grants
      else {
        badge = { text: "⛔ Sin acceso", tone: "bad" };
        headline = "No hay credenciales asociadas";
        bodyHtml = `<p class="muted">Contacta al host para soporte.</p>`;
      }

      return res.status(200).type("html").send(
        renderPage({
          title: "Pin&Go • Acceso",
          badge,
          body: `
            <h1>${escapeHtml(headline)}</h1>
            <p class="sub">Hola <b>${escapeHtml(reservation.guestName ?? "Guest")}</b></p>
            ${bodyHtml}
            ${autoRefreshScript(shouldAutoRefresh)}
            <div class="footer">
              <span class="brand">Pin&Go</span>
              <span class="muted small">Control de acceso • Seguro • Automático</span>
            </div>
          `,
        })
      );
    } catch (e: any) {
      console.error("guest portal error:", e?.message ?? e);
      return res.status(500).type("html").send(
        renderPage({
          title: "Pin&Go • Error",
          badge: { text: "⚠️ Error", tone: "bad" },
          body: `<p class="muted">Ocurrió un error cargando el acceso.</p>`,
        })
      );
    }
  });

   // =====================
  // GUEST VERIFY PAGE
  // =====================
  router.get(
    "/guest/verify/:token",
    async (req, res) => {
      try {
        const token = String(
          req.params.token ?? ""
        ).trim();

        const now = new Date();

        if (!token) {
          return res
            .status(400)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "Token requerido",
                  tone: "bad",
                },
                body: `
                  <h1>Enlace incompleto</h1>
                  <p class="muted">
                    Falta el token de verificación.
                  </p>
                `,
              })
            );
        }

        const reservation =
          await prisma.reservation.findFirst({
            where: {
              guestToken: token,
              guestTokenExpiresAt: {
                gt: now,
              },
            },
            include: {
              property: true,
            },
          });

        if (!reservation) {
          return res
            .status(404)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "No disponible",
                  tone: "bad",
                },
                body: `
                  <h1>Enlace inválido o expirado</h1>
                  <p class="muted">
                    Solicita un enlace nuevo al host.
                  </p>
                `,
              })
            );
        }

        const language = resolveGuestLanguage(
          reservation.preferredLanguage
        );

        const isSpanish = language === "es";

        const reservationReference =
          reservation.reservationNumber ??
          "No disponible";

        if (
          reservation.status !== "ACTIVE" ||
          reservation.checkOut.getTime() <=
            now.getTime()
        ) {
          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "Reserva no activa",
                  tone: "bad",
                },
                body: `
                  <h1>Verificación no disponible</h1>
                  <div class="card">
                    <div class="row">
                      <span class="k">
                      ${isSpanish ? "Reservación" : "Reservation"}
                    </span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                  </div>
                  <p class="muted">
                    Contacta al host si necesitas ayuda.
                  </p>
                `,
              })
            );
        }

        if (
          reservation.paymentState !== "PAID"
        ) {
          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "Pago pendiente",
                  tone: "warn",
                },
                body: `
                  <h1>La reserva aún no está lista</h1>
                  <div class="card">
                    <div class="row">
                      <span class="k">Reserva</span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                  </div>
                  <p class="muted">
                    La verificación estará disponible cuando el pago quede confirmado.
                  </p>
                `,
              })
            );
        }

                let agreementSnapshot: unknown =
          reservation.guestAgreementSnapshot;

        if (!agreementSnapshot) {
          const captureResult =
            await ensureReservationGuestAgreementSnapshot(
              prisma,
              reservation.id
            );

          if (
            captureResult.ok &&
            captureResult.snapshot
          ) {
            agreementSnapshot =
              captureResult.snapshot;

            console.log(
              "[GUEST_VERIFICATION] agreement snapshot captured",
              {
                reservationNumber:
                  reservation.reservationNumber ??
                  null,
                propertyId:
                  reservation.propertyId,
                agreementVersion:
                  (
                    captureResult.snapshot as {
                      version?: string;
                    }
                  ).version ?? null,
              }
            );
          }
        }

        const agreement =
          readGuestAgreementSnapshot(
            agreementSnapshot
          );
        if (!agreement) {
          console.error(
            "[GUEST_VERIFICATION] agreement snapshot missing",
            {
              reservationNumber:
                reservation.reservationNumber,
              propertyId:
                reservation.propertyId,
            }
          );

          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "Configuración pendiente",
                  tone: "bad",
                },
                body: `
                  <h1>No podemos iniciar la verificación</h1>
                  <div class="card">
                    <div class="row">
                      <span class="k">Reserva</span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                  </div>
                  <p class="muted">
                    El acuerdo de esta propiedad todavía no está disponible. Pin&Go no liberará el acceso hasta resolverlo.
                  </p>
                `,
              })
            );
        }

        const identityVerificationRequired =
          agreement.requiresIdentityVerification !== false;

        const cancellationPolicy =
          readCancellationPolicyView(
            reservation
              .cancellationPolicySnapshot,
            language,
            reservation.checkIn
          );
        
        if (!cancellationPolicy) {
          console.error(
            "[GUEST_VERIFICATION] cancellation policy snapshot missing",
            {
              reservationNumber:
                reservation.reservationNumber,
              propertyId:
                reservation.propertyId,
            }
          );

          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text:
                    "Configuración pendiente",
                  tone: "bad",
                },
                body: `
                  <h1>
                    ${
                      isSpanish
                        ? "Política de cancelación no disponible"
                        : "Cancellation policy unavailable"
                    }
                  </h1>

                  <div class="card">
                    <div class="row">
                      <span class="k">
                        ${isSpanish ? "Reservación" : "Reservation"}
                      </span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                  </div>

                  <p class="muted">
                    ${
                      isSpanish
                        ? "Pin&Go no puede continuar hasta que estén disponibles los términos de cancelación y reembolso de esta reservación."
                        : "Pin&Go cannot continue until the cancellation and refund terms for this reservation are available."
                    }
                  </p>
                `,
              })
            );
        }

       const cancellationAlreadyAccepted =
         cancellationPolicy
           .cancellationAccepted;

       const cancellationPolicyPresentation =
         cancellationPolicy.presentation;

       const smsAlreadyConsented =
          hasRecordedSmsConsent(
            reservation.externalRaw
          );

        const guestHasPhone =
          Boolean(
            String(
              reservation.guestPhone ??
                ""
            ).trim()
          );
        const maxGuests =
          reservation.property?.maxGuests;

        if (
          !Number.isInteger(maxGuests) ||
          Number(maxGuests) < 1
        ) {
          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Guest Verification",
                badge: {
                  text: "Configuración pendiente",
                  tone: "bad",
                },
                body: `
                  <h1>Capacidad no configurada</h1>
                  <p class="muted">
                    El host debe configurar la capacidad máxima antes de continuar.
                  </p>
                `,
              })
            );
        }

        if (
          identityVerificationRequired &&
          reservation.verificationStatus ===
          "REVIEW_REQUIRED"
        ) {
          return res
            .status(409)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Identity Review",
                badge: {
                  text: "Revisión requerida",
                  tone: "warn",
                },
                body: `
                  <h1>Necesitamos revisar su identidad</h1>
                  <div class="card">
                    <div class="row">
                      <span class="k">Reserva</span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                  </div>
                  <p class="muted">
                    La verificación fue recibida, pero el nombre del documento no coincidió con la información de la reserva. El acceso permanece protegido.
                  </p>
                  <p class="muted">
                    Contacta al host para completar una revisión manual.
                  </p>
                `,
              })
            );
        }

        const identityRequirementCompleted =
          identityVerificationRequired
            ? reservation.verificationStatus ===
                "COMPLETED" &&
              Boolean(reservation.verifiedAt)
            : reservation.verificationStatus ===
                "NOT_REQUIRED" &&
              Boolean(
                reservation.guestAgreementSignedAt
              );

        if (identityRequirementCompleted) {
          const readiness =
            await evaluateGuestAccessReadiness(
              prisma,
              reservation.id,
              {
                persist: true,
                now,
              }
            );

          return res
            .status(200)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Registration Complete",
                badge: {
                  text: readiness.ready
                    ? identityVerificationRequired
                      ? "Verificación completada"
                      : "Registro completado"
                    : "Procesando requisitos",
                  tone: readiness.ready
                    ? "good"
                    : "warn",
                },
                body: `
                  <h1>${
                    readiness.ready
                      ? "Todo está listo"
                      : "Estamos completando su registro"
                  }</h1>

                  <div class="card">
                    <div class="row">
                      <span class="k">Reserva</span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                    <div class="row">
                      <span class="k">
                      ${isSpanish ? "Propiedad" : "Property"}
                    </span>
                      <span class="v">${escapeHtml(
                        reservation.property?.name ??
                          "N/A"
                      )}</span>
                    </div>
                    <div class="row">
                      <span class="k">Identidad</span>
                      <span class="v">${
                        identityVerificationRequired
                          ? "Verificada"
                          : "No requerida"
                      }</span>
                    </div>
                    <div class="row">
                      <span class="k">Acuerdo</span>
                      <span class="v">Aceptado</span>
                    </div>
                  </div>

                  <p class="muted">
                    ${
                      readiness.ready
                        ? "Pin&Go programará automáticamente su acceso según el horario de check-in."
                        : "El acceso permanecerá protegido hasta que todos los requisitos estén completos."
                    }
                  </p>

                  <p>
                    <a class="link" href="/guest/${encodeURIComponent(
                      token
                    )}">
                      Ver estado de acceso
                    </a>
                  </p>
                `,
              })
            );
        }

        const returnedFromIdentity =
          String(req.query.identity ?? "") ===
          "returned";

        if (
          identityVerificationRequired &&
          returnedFromIdentity &&
          reservation.verificationStatus ===
            "IN_PROGRESS"
        ) {
            return res
            .status(200)
            .type("html")
            .send(
              renderPage({
                title:
                  "Pin&Go • Processing Verification",
                badge: {
                  text: "Procesando",
                  tone: "warn",
                },
                body: `
                  <h1>Estamos validando su identidad</h1>
                  <div class="card">
                    <div class="row">
                      <span class="k">Reserva</span>
                      <span class="v">${escapeHtml(
                        reservationReference
                      )}</span>
                    </div>
                    <div class="row">
                      <span class="k">Estado</span>
                      <span class="v">
                        <span id="autorefresh" class="muted">
                          Esperando resultado seguro...
                        </span>
                      </span>
                    </div>
                  </div>
                  <p class="muted">
                    Este proceso normalmente tarda pocos segundos.
                  </p>
                  ${autoRefreshScript(true)}
                `,
              })
            );
        }

        const legalNameValue = escapeHtml(
          reservation.identityDeclaredLegalName ??
            ""
        );

        return res
          .status(200)
          .type("html")
          .send(
            renderPage({
              title: isSpanish
                ? "Pin&Go • Verificación del huésped"
                : "Pin&Go • Guest Verification",
              badge: {
                text: identityVerificationRequired
                  ? isSpanish
                    ? "Verificación requerida"
                    : "Verification required"
                  : isSpanish
                  ? "Registro seguro"
                  : "Secure registration",
                tone: identityVerificationRequired
                  ? "warn"
                  : "good",
              },
              body: `
                <h1>
                  ${
                    isSpanish
                      ? "Complete su registro previo al check-in"
                      : "Complete your pre-check-in registration"
                  }
                </h1>

                <p class="sub">
                  ${isSpanish ? "Hola" : "Hello"} <b>${escapeHtml(
                    reservation.guestName ??
                      "Guest"
                  )}</b>
                </p>

                <div class="card">
                  <div class="row">
                    <span class="k">Reserva</span>
                    <span class="v">${escapeHtml(
                      reservationReference
                    )}</span>
                  </div>
                  <div class="row">
                    <span class="k">Propiedad</span>
                    <span class="v">${escapeHtml(
                      reservation.property?.name ??
                        "N/A"
                    )}</span>
                  </div>
                  <div class="row">
                    <span class="k">Check-in</span>
                    <span class="v">${escapeHtml(
                     fmtLocal(
  reservation.checkIn,
  reservation.property?.timezone
)
                    )}</span>
                  </div>
                  <div class="row">
                    <span class="k">Check-out</span>
                    <span class="v">${escapeHtml(
                     fmtLocal(
  reservation.checkOut,
  reservation.property?.timezone
)
                    )}</span>
                  </div>
                </div>

                ${
                  agreement.guestFacingSummary
                    ? `
                      <div class="card notice">
                        <p class="agreement-text">
                          ${renderMultilineText(
                            agreement.guestFacingSummary
                          )}
                        </p>
                      </div>
                    `
                    : ""
                }

                <div class="card">
                  <h2>${escapeHtml(
                    agreement.title
                  )}</h2>
                  <p class="muted small">
                    ${isSpanish ? "Versión" : "Version"} ${escapeHtml(
                      agreement.version
                    )}
                  </p>
                  <div class="agreement-text">
                    ${renderMultilineText(
                      agreement.agreementText
                    )}
                  </div>
                </div>
                  <div class="card">
                  <h2>
                    ${isSpanish
                      ? "Reglas de la propiedad"
                      : "Property Rules"}
                  </h2>
                  ${renderAgreementRules(
                    agreement.rules,
                    language
                  )}
                </div>

                <div class="card">
                  <h2>
                    ${isSpanish
                      ? "Política de cancelación y reembolso"
                      : "Cancellation & Refund Policy"}
                  </h2>
                  
                 <p>
  <strong>${escapeHtml(
    cancellationPolicyPresentation.title
  )}</strong>
</p>

<p>
  ${renderMultilineText(
    cancellationPolicyPresentation.summary
  )}
</p>

<div class="row">
  <span class="k">
    ${
      isSpanish
        ? "Base del reembolso"
        : "Refund basis"
    }
  </span>

  <span class="v">
    ${renderMultilineText(
      cancellationPolicyPresentation
        .refundBasisDisclosure
    )}
  </span>
</div>

${renderCancellationRefundRules(
  cancellationPolicyPresentation.rules
)}

                  ${
                   cancellationAlreadyAccepted
                     ? `
                         <p class="muted small">
                           ${
                             isSpanish
                               ? "✓ La aceptación de los términos de cancelación ya está registrada."
                               : "✓ Cancellation terms acceptance is already recorded."
                           }
                         </p>
                       `
                     : `
      <p class="muted small">
        ${
          isSpanish
            ? "Debe revisar y aceptar estos términos antes de continuar."
            : "You must review and accept these terms before continuing."
        }
      </p>
    `
                  }
                </div>

                <form
                  method="POST"
                  action="/guest/verify/${encodeURIComponent(
                    token
                  )}"
                >
                  <div class="card">
                    <label class="label">
                      ${isSpanish
                        ? "Nombre legal completo"
                        : "Full legal name"}
                    </label>

                    <input
                      class="input"
                      type="text"
                      name="legalName"
                      minlength="2"
                      maxlength="120"
                      autocomplete="name"
                      value="${legalNameValue}"
                      required
                    />

                    <p class="input-help">
                      ${
                        identityVerificationRequired
                          ? isSpanish
                            ? "Escríbalo exactamente como aparece en el documento oficial que utilizará."
                            : "Enter it exactly as it appears on the official document you will use."
                          : isSpanish
                          ? "Escriba el nombre completo de la persona que acepta el acuerdo de alojamiento."
                          : "Enter the full name of the person accepting the accommodation agreement."
                      }
                    </p>

                    <label class="label">
                      ${isSpanish
                        ? "Cantidad total de huéspedes"
                        : "Total number of guests"}
                    </label>

                    <input
                      class="input"
                      type="number"
                      name="guestCount"
                      min="1"
                      max="${Number(
                        maxGuests
                      )}"
                      required
                    />

                    <p class="input-help">
                      ${
                        isSpanish
                          ? `Capacidad máxima: ${Number(
                              maxGuests
                            )} huéspedes.`
                          : `Maximum occupancy: ${Number(
                              maxGuests
                            )} guests.`
                      }
                    </p>

                    <label class="checkbox">
                      <input
                        type="checkbox"
                        name="authorizedGuestAccepted"
                        value="yes"
                        required
                      />
                      <span>
                        ${
                          isSpanish
                            ? "Confirmo que soy el huésped autorizado de esta reservación y que la información suministrada es correcta."
                            : "I confirm that I am the authorized guest for this reservation and that the information provided is accurate."
                        }
                      </span>
                    </label>
                    <label class="checkbox">
                      <input
                        type="checkbox"
                        name="agreementAccepted"
                        value="yes"
                        required
                      />
                      <span>
                        ${
                          isSpanish
                            ? `He leído y acepto el acuerdo de alojamiento versión ${escapeHtml(
                                agreement.version
                              )}.`
                            : `I have read and accept accommodation agreement version ${escapeHtml(
                                agreement.version
                              )}.`
                        }
                      </span>
                    </label>

                    <label class="checkbox">
                      <input
                        type="checkbox"
                        name="rulesAccepted"
                        value="yes"
                        required
                      />
                      <span>
                        ${
                          isSpanish
                            ? "He leído y acepto las reglas de la propiedad."
                            : "I have read and accept the property rules."
                        }
                      </span>
                    </label>

                    ${
                      identityVerificationRequired
                        ? `
                          <label class="checkbox">
                            <input
                              type="checkbox"
                              name="identityConsentAccepted"
                              value="yes"
                              required
                            />
                            <span>
                              ${
                                isSpanish
                                  ? "Autorizo la verificación de mi documento oficial y selfie mediante Stripe Identity para confirmar que soy el huésped autorizado. Pin&Go no almacenará las imágenes del documento ni de la selfie."
                                  : "I authorize verification of my official document and selfie through Stripe Identity to confirm that I am the authorized guest. Pin&Go will not store images of the document or selfie."
                              }
                            </span>
                          </label>
                        `
                        : ""
                    }

                    ${
                      !cancellationAlreadyAccepted
                        ? `
                          <label class="checkbox">
                            <input
                              type="checkbox"
                              name="cancellationTermsAccepted"
                              value="yes"
                              required
                            />
                            <span>
                              ${
                                isSpanish
                                  ? "He revisado y acepto la política de cancelación y reembolso mostrada arriba, incluyendo cómo se calcula cualquier reembolso elegible."
                                  : "I have reviewed and agree to the cancellation and refund policy shown above, including how any eligible refund is calculated."
                              }
                            </span>
                          </label>
                        `
                        : ""
                    }

                    ${
                      smsAlreadyConsented
                        ? `
                          <div class="card">
                            <p class="muted small">
                              ${
                                isSpanish
                                  ? "✓ El consentimiento SMS ya está registrado para esta reservación."
                                  : "✓ SMS consent is already recorded for this reservation."
                              }
                            </p>
                          </div>
                        `
                        : guestHasPhone
                        ? `
                          <div class="card">
                            <h3>
                              ${
                                isSpanish
                                  ? "Actualizaciones SMS de Pin&Go Smart Stay (Opcional)"
                                  : "Pin&Go Smart Stay SMS Updates (Optional)"
                              }
                            </h3>

                            <label class="checkbox">
                              <input
                                type="checkbox"
                                name="smsConsent"
                                value="yes"
                              />
                              <span>
                                ${
                                  isSpanish
                                    ? "Acepto recibir mensajes SMS transaccionales de PIN&GO LLC relacionados con esta reservación, incluyendo actualizaciones, códigos de acceso, instrucciones de check-in, recordatorios de check-out y alertas de la propiedad."
                                    : "I agree to receive transactional SMS messages from PIN&GO LLC about this reservation, including booking updates, smart-lock access codes, check-in instructions, check-out reminders, and property alerts."
                                }
                              </span>
                            </label>

                            <p class="muted small">
                              ${
                                isSpanish
                                  ? "Opcional. El consentimiento no es una condición de la reservación. La frecuencia de mensajes varía. Pueden aplicar cargos por mensajes y datos. Responda STOP para cancelar y HELP para recibir ayuda."
                                  : "Optional. Consent is not a condition of the reservation. Message frequency varies. Message and data rates may apply. Reply STOP to opt out and HELP for assistance."
                              }
                            </p>

                            <p class="muted small">
                              <a
                                class="link"
                                href="https://app.pin-ngo.com/legal/terms"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                ${isSpanish ? "Términos" : "Terms"}
                              </a>
                              ·
                              <a
                                class="link"
                                href="https://app.pin-ngo.com/legal/privacy"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                ${isSpanish ? "Privacidad" : "Privacy"}
                              </a>
                            </p>
                          </div>
                        `
                        : `
                          <div class="card">
                            <p class="muted small">
                              ${
                                isSpanish
                                  ? "No hay un número telefónico registrado para esta reservación, por lo que Pin&Go utilizará el correo electrónico para las comunicaciones de la estadía."
                                  : "No phone number is registered for this reservation, so Pin&Go will use email for stay communications."
                              }
                            </p>
                          </div>
                        `
                    }

                    ${
                      identityVerificationRequired
                        ? `
                          <p class="muted small">
                            ${
                              isSpanish
                                ? "Si no puede utilizar la verificación automática, contacte al host para solicitar una alternativa de revisión."
                                : "If you cannot use automatic verification, contact the host to request an alternative review."
                            }
                          </p>
                        `
                        : ""
                    }

                    <button
                      class="btn"
                      type="submit"
                    >
                      ${
                        identityVerificationRequired
                          ? isSpanish
                            ? "Aceptar y verificar identidad"
                            : "Accept and verify identity"
                          : isSpanish
                          ? "Aceptar y completar registro"
                          : "Accept and complete registration"
                      }
                    </button>
                  </div>
                </form>

                <div class="footer">
                  <span class="brand">
                    Pin&Go
                  </span>
                  <span class="muted small">
                    ${
                      identityVerificationRequired
                        ? isSpanish
                          ? "Verificación segura del huésped"
                          : "Secure Guest Verification"
                        : isSpanish
                        ? "Registro seguro del huésped"
                        : "Secure Guest Registration"
                    }
                  </span>
                </div>
              `,
            })
          );
      } catch (err: any) {
        console.error(
          "[guest verify GET]",
          err?.message ?? err
        );

        return res
          .status(500)
          .type("html")
          .send(
            renderPage({
              title: "Pin&Go • Error",
              badge: {
                text: "Error",
                tone: "bad",
              },
              body: `
                <h1>No pudimos cargar la verificación</h1>
                <p class="muted">
                  Intenta nuevamente o contacta al host.
                </p>
              `,
            })
          );
      }
    }
  );

  // =====================
  // ACCEPT AGREEMENT + START IDENTITY
  // =====================
  router.post(
    "/guest/verify/:token",
    async (req, res) => {
      const token = String(
        req.params.token ?? ""
      ).trim();

      try {
        const rawGuestCount = Number(
          req.body?.guestCount
        );

        const guestCount =
          Number.isFinite(rawGuestCount)
            ? Math.floor(rawGuestCount)
            : 0;

        const result =
          await completeGuestAgreementAndStartIdentity(
            prisma,
            {
              guestToken: token,
              legalName: String(
                req.body?.legalName ?? ""
              ),
              guestCount,
              authorizedGuestAccepted:
                req.body
                  ?.authorizedGuestAccepted ===
                "yes",
              agreementAccepted:
                req.body?.agreementAccepted ===
                "yes",
              rulesAccepted:
                req.body?.rulesAccepted ===
                "yes",
              identityConsentAccepted:
                req.body
                  ?.identityConsentAccepted ===
                "yes",
              cancellationTermsAccepted:
                req.body
                  ?.cancellationTermsAccepted ===
                "yes",
              smsConsent:
                req.body?.smsConsent ===
                "yes",
              ipAddress: getRequestIp(req),
              userAgent:
                typeof req.headers[
                  "user-agent"
                ] === "string"
                  ? req.headers["user-agent"]
                  : null,
              returnUrl: getGuestReturnUrl(
                req,
                token
              ),
            }
          );

        if (result.identitySession.url) {
          return res.redirect(
            303,
            result.identitySession.url
          );
        }

        return res.redirect(
          303,
          `/guest/verify/${encodeURIComponent(
            token
          )}?identity=returned`
        );
      } catch (err: any) {
        const code = String(
          err?.message ?? err
        );

        const guestMessages: Record<
          string,
          string
        > = {
          GUEST_VERIFICATION_LINK_INVALID_OR_EXPIRED:
            "El enlace es inválido o expiró.",
          GUEST_VERIFICATION_PAYMENT_NOT_PAID:
            "El pago de la reserva todavía no está confirmado.",
          GUEST_VERIFICATION_PROPERTY_MAX_GUESTS_MISSING:
            "La capacidad máxima de la propiedad no está configurada.",
          GUEST_VERIFICATION_GUEST_COUNT_INVALID:
            "La cantidad de huéspedes no es válida.",
          GUEST_VERIFICATION_LEGAL_NAME_INVALID:
            "Escribe tu nombre legal completo.",
          GUEST_VERIFICATION_AUTHORIZED_GUEST_REQUIRED:
            "Debes confirmar que eres el huésped autorizado.",
          GUEST_VERIFICATION_AGREEMENT_REQUIRED:
            "Debes aceptar el acuerdo de alojamiento.",
          GUEST_VERIFICATION_RULES_REQUIRED:
            "Debes aceptar las reglas de la propiedad.",
          GUEST_VERIFICATION_IDENTITY_CONSENT_REQUIRED:
            "Debes autorizar la verificación de identidad o contactar al host para una alternativa.",
          GUEST_VERIFICATION_AGREEMENT_SNAPSHOT_INVALID:
            "El acuerdo de esta reserva no está disponible.",
          GUEST_IDENTITY_MAX_VERIFICATION_ATTEMPTS_REACHED:
            "Se alcanzó el máximo de intentos. Contacta al host para revisión.",
        };

        const message =
          guestMessages[code] ??
          "No pudimos iniciar la verificación. Intenta nuevamente o contacta al host.";

        console.error(
          "[guest verify POST]",
          {
            errorCode: code,
          }
        );

        return res
          .status(400)
          .type("html")
          .send(
            renderPage({
              title:
                "Pin&Go • Verification Error",
              badge: {
                text:
                  "No se pudo continuar",
                tone: "bad",
              },
              body: `
                <h1>Verificación pendiente</h1>
                <p class="muted">
                  ${escapeHtml(message)}
                </p>
                <p>
                  <a
                    class="link"
                    href="/guest/verify/${encodeURIComponent(
                      token
                    )}"
                  >
                    Volver a intentar
                  </a>
                </p>
              `,
            })
          );
      }
    }
  );

  // ✅ Alias opcional (si quieres mantener /checkin/:token)
  router.get("/checkin/:token", (req, res) => {
    const token = String(req.params.token ?? "").trim();
    return res.redirect(`/guest/${encodeURIComponent(token)}`);
  });

  return router;
}

/* =====================
   HTML Layout
===================== */
function renderPage(args: {
  title: string;
  badge: { text: string; tone: "good" | "warn" | "bad" };
  body: string;
}) {
  const toneClass =
    args.badge.tone === "good" ? "good" : args.badge.tone === "warn" ? "warn" : "bad";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(args.title)}</title>
  <style>
    :root { --bg:#0b1220; --card:#121a2b; --txt:#e7eefc; --mut:#9db0d1; --line:#24304a; }
    body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--txt); }
    .wrap { max-width:720px; margin:0 auto; padding:24px 16px 40px; }
    .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .logo { font-weight:800; }
    .badge { font-size:13px; padding:6px 10px; border-radius:999px; border:1px solid var(--line); }
    .badge.good { background:rgba(36,180,120,.14); }
    .badge.warn { background:rgba(240,180,60,.14); }
    .badge.bad  { background:rgba(240,80,80,.14); }
    h1 { margin:10px 0 6px; font-size:22px; }
    .sub { margin:0 0 14px; color:var(--mut); }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin:12px 0; }
    .row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; }
    .k { color:var(--mut); font-size:13px; }
    .v { font-size:14px; text-align:right; }
    .code { font-weight:800; }

.label {
  display:block;
  font-size:13px;
  color:var(--mut);
  margin-bottom:8px;
}

.input {
  width:100%;
  box-sizing:border-box;
  padding:12px 14px;
  border-radius:12px;
  border:1px solid var(--line);
  background:#0f1728;
  color:var(--txt);
  font-size:16px;
  margin-bottom:14px;
  outline:none;
}

.input:focus {
  border-color:#2f6df6;
}

.checkbox {
  display:flex;
  align-items:flex-start;
  gap:10px;
  color:var(--txt);
  font-size:14px;
  line-height:1.4;
  margin:12px 0 16px;
}

.checkbox input {
  margin-top:3px;
}

.btn {
  width:100%;
  border:0;
  border-radius:12px;
  padding:13px 14px;
  background:#2f6df6;
  color:white;
  font-weight:800;
  font-size:15px;
  cursor:pointer;
}

.btn:active {
  transform:translateY(1px);
}

.link {
  color:#9dbdff;
  font-weight:700;
  text-decoration:none;
}

.agreement-text {
  line-height:1.6;
  font-size:14px;
  color:var(--txt);
}

.rules {
  margin:10px 0 0;
  padding-left:22px;
  color:var(--txt);
  line-height:1.6;
  font-size:14px;
}

.notice {
  border-left:3px solid #2f6df6;
}

.input-help {
  color:var(--mut);
  font-size:12px;
  margin:-8px 0 14px;
}

.muted { color:var(--mut); }
.small { font-size:12px; }
.footer { margin-top:18px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
.brand { font-weight:800; }

  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="logo">Pin&Go</div>
      <div class="badge ${toneClass}">${escapeHtml(args.badge.text)}</div>
    </div>
    ${args.body}
  </div>
</body>
</html>`;
}
