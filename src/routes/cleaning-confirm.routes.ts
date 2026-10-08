import { acceptCleaningOffer, withdrawCleaning, CleaningReassignmentError } from "../services/cleaning-reassignment.service.js";
import { loadCleanerActivation } from "../services/cleaner-account.service.js";
import { Router } from "express";
import {
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "../services/cleaner-access-autopilot.service";
import { auditReservationCompleteFlowSafe } from "../services/reservation-complete-flow-audit.service";
import { materializeCleaningWorkSnapshot } from "../services/cleaning-work-snapshot.service.js";
import { createCleaningWorkSnapshotStore } from "../services/cleaning-work-snapshot.prisma.js";
import { acceptCleaningTimingConsent } from "../services/cleaning-timing-consent.prisma.js";
import { buildCleaningTimingConsentSnapshot } from "../services/cleaning-timing-consent.js";
import { confirmCleaningStart } from "../services/cleaning-work-start.prisma.js";
import { confirmCleaningCompletion } from "../services/cleaning-work-completion.prisma.js";
import { readCleaningActionWindow, CleaningActionWindowError, type CleaningActionWindow } from "../services/cleaning-action-window.js";
import { renderCleaningActionButton } from "../services/cleaning-action-button.js";
import { CleaningChecklistError, readOwnChecklist, setChecklistItem } from "../services/cleaning-checklist.service.js";
import { renderCleaningChecklist } from "../services/cleaning-checklist-render.js";
import { resolveCleaningHostAttention } from "../services/cleaning-followup-host-attention.service.js";
import { getStaffIntlLocale, resolveStaffLanguage, type StaffLanguage } from "../services/staff-language.service.js";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

// Only the separate activation capability delivered in a newly built SMS adds this action.
cleaningConfirmRouter.use("/cleaning/confirm/:token", async (req, res, next) => {
  // Preserve same-origin form POSTs while withholding capability URLs from other sites.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  const activationToken = String(req.query.activation ?? "");
  if (req.method !== "GET" || !/^[a-f0-9]{48}$/.test(activationToken)) return next();
  try {
    const activation = await loadCleanerActivation(prisma, activationToken);
    const confirmation = await prisma.cleaningConfirmation.findUnique({ where: { token: String(req.params.token) } });
    if (confirmation?.id !== activation.confirmationId) return next();
    const es = activation.staffMember.preferredLanguage === "es";
    const send = res.send.bind(res);
    res.send = ((body: any) => {
      if (typeof body === "string" && res.statusCode < 400 && body.includes("</section>")) {
        body = body.replace("</section>", `<a class="cleaner-action" href="/cleaning/account/activate/${activationToken}">${es ? "Activar mi cuenta" : "Activate my account"}</a></section>`);
      }
      return send(body);
    }) as typeof res.send;
  } catch { /* An invalid activation capability never changes the existing cleaning flow. */ }
  return next();
});


function sendCancelledCleaningRequestResponse(res: any, language: StaffLanguage = "en") {
  return res.status(410).send(language === "es"
    ? "Esta solicitud de limpieza ya no esta activa porque la reservacion fue cancelada. No se requiere ninguna accion de limpieza o acceso."
    : "This cleaning request is no longer active because the reservation was cancelled. No cleaning or access action is required.");
}

function sendCleaningNfcDisabledResponse(res: any, language: StaffLanguage = "en") {
  return res.status(410).send(language === "es"
    ? "Esta solicitud de acceso para limpieza ya no esta activa porque Cleaning NFC esta deshabilitado para esta propiedad. No se requiere confirmacion ni accion de acceso."
    : "This cleaning access request is no longer active because Cleaning NFC is disabled for this property. No confirmation or access action is required.");
}

function sendExpiredCleaningRequestResponse(res: any, language: StaffLanguage = "en") {
  return res.status(410).send(language === "es"
    ? "Esta solicitud de limpieza ya no esta activa porque Pin&Go la asigno a otro personal de limpieza. No se requiere ninguna accion."
    : "This cleaning request is no longer active because Pin&Go assigned it to another cleaner. No action is required.");
}

function sendCleaningActionWindowFailure(res: any, error: CleaningActionWindowError, language: StaffLanguage) {
  const es = language === "es";
  const text = error.message === "CLEANING_ACTION_TOO_EARLY"
    ? (es ? "Esta acción estará disponible desde el inicio programado." : "This action is available from the scheduled start.")
    : error.message === "CLEANING_COMPLETION_BEFORE_START"
      ? (es ? "Debes iniciar la limpieza antes de finalizarla." : "You must start cleaning before finishing it.")
      : (es ? "El horario ya no permite esta acción. Actualiza la página para revisar la limpieza." : "The current schedule does not allow this action. Refresh the page to review the cleaning.");
  return res.status(409).send(cleanerPage(`<h2>${es ? "Revisa el horario" : "Review the schedule"}</h2><p role="alert">${text}</p>`, language));
}

function cancelForm(token: string, language: StaffLanguage) {
  const es = language === "es";
  return `<details><summary>${es ? "Cancelar limpieza" : "Cancel cleaning"}</summary><p>${es ? "Confirma si ya no puedes realizar esta limpieza. Pin&Go buscará un respaldo." : "Confirm if you can no longer perform this cleaning. Pin&Go will look for a backup."}</p><form method="POST" action="/cleaning/confirm/${encodeURIComponent(token)}/cancel"><button class="cleaner-action cleaner-action-secondary">${es ? "Sí, cancelar limpieza" : "Yes, cancel cleaning"}</button></form></details>`;
}
cleaningConfirmRouter.post("/cleaning/confirm/:token/cancel", async (req, res) => {
  let language: StaffLanguage = "en";
  try {
    const data = await loadConfirmationData(String(req.params.token));
    language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);
    if (!data?.reservation || !data.staffMember) throw new CleaningReassignmentError("CLEANING_NOT_AVAILABLE", 404);
    const result = await withdrawCleaning(prisma, { confirmationId: data.confirmation.id, staffMemberId: data.staffMember.id, organizationId: data.staffMember.organizationId }, "cancel");
    return res.send(cleanerPage(`<h2>${language === "es" ? "Limpieza cancelada" : "Cleaning cancelled"}</h2><p>${result.nextConfirmationId ? (language === "es" ? "Pin&Go ofrecerá la limpieza al siguiente respaldo." : "Pin&Go will offer the cleaning to the next backup.") : (language === "es" ? "La cancelación quedó registrada." : "Your cancellation was recorded.")}</p>`, language));
  } catch (error) {
    return res.status(error instanceof CleaningReassignmentError ? error.status : 500).send(cleanerPage(`<p role="alert">${language === "es" ? "No se pudo cancelar. Actualiza la limpieza; una limpieza iniciada requiere reportar una incidencia." : "Could not cancel. Refresh the cleaning; a started cleaning requires reporting an issue."}</p>`, language));
  }
});

function checklistBlockReason(checklist: { items: { required: boolean; checked: boolean }[] }, language: StaffLanguage) {
  return checklist.items.some(item => item.required && !item.checked)
    ? (language === "es" ? "Completa los puntos obligatorios del checklist antes de finalizar." : "Complete the required checklist items before finishing.") : undefined;
}

cleaningConfirmRouter.post("/cleaning/confirm/:token/checklist/:itemId", async (req, res) => {
  let language: StaffLanguage = "en";
  try {
    const token = String(req.params.token);
    const data = await loadConfirmationData(token);
    language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);
    if (!data?.reservation || !data.staffMember?.isActive || data.reservation.property.organizationId !== data.staffMember.organizationId) return res.status(404).send(cleanerPage(`<p>${language === "es" ? "Limpieza no disponible." : "Cleaning not available."}</p>`, language));
    await setChecklistItem(prisma, { confirmationId: data.confirmation.id, staffMemberId: data.staffMember.id, organizationId: data.staffMember.organizationId, itemId: String(req.params.itemId), checked: req.body?.checked === "true", version: Number(req.body?.version) });
    return res.redirect(303, `/cleaning/confirm/${encodeURIComponent(token)}`);
  } catch (error) {
    return res.status(error instanceof CleaningChecklistError ? error.status : 409).send(cleanerPage(`<p role="alert">${language === "es" ? "No se pudo guardar este punto. Actualiza la limpieza e inténtalo de nuevo." : "Could not save this item. Refresh the cleaning and try again."}</p>`, language));
  }
});

async function loadConfirmationData(token: string) {
  const confirmation = await prisma.cleaningConfirmation.findUnique({
    where: { token },
  });

  if (!confirmation) return null;

  const [reservation, staffMember] = await Promise.all([
    prisma.reservation.findUnique({
      where: { id: confirmation.reservationId },
      include: {
        property: {
          include: {
            locks: true,
          },
        },
      },
    }),
    prisma.staffMember.findUnique({
      where: { id: confirmation.staffMemberId },
    }),
  ]);

  if (!reservation || !staffMember) {
    return {
      confirmation,
      reservation,
      staffMember,
      invalidData: true,
    };
  }

  return {
    confirmation,
    reservation,
    staffMember,
    invalidData: false,
  };
}

function formatPropertyLocal(value: Date, timeZone: string, language: StaffLanguage = "en") {
  try {
    return new Intl.DateTimeFormat(getStaffIntlLocale(language), {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(value);
  } catch {
    return value.toISOString().replace("T", " ").replace(".000Z", " UTC");
  }
}

function cleanerPage(content: string, language: StaffLanguage = "en") {
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <style>
    *{box-sizing:border-box} body{margin:0;background:#f8fafc;color:#111827;font-family:Arial,sans-serif;font-size:17px;line-height:1.55}
    .cleaner-shell{width:min(100%,680px);margin:0 auto;padding:24px 18px 40px}
    .cleaner-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;box-shadow:0 8px 28px rgba(15,23,42,.06)}
    h2{font-size:26px;line-height:1.2;margin:0 0 20px} p{margin:0 0 14px} b{font-weight:750}
    .cleaner-action{display:block;width:100%;min-height:52px;padding:14px 18px;margin-top:20px;border:0;border-radius:12px;background:#2563eb;color:#fff;font-size:17px;font-weight:750;line-height:1.25;white-space:normal}.cleaner-action-secondary{background:#fff;color:#b91c1c;border:1px solid #fecaca}
    .cleaner-note{margin-top:14px;font-size:14px;line-height:1.5;color:#6b7280}
    @media(max-width:480px){.cleaner-shell{padding:16px 12px 28px}.cleaner-card{padding:20px 16px;border-radius:14px}h2{font-size:24px}.cleaner-action{font-size:17px;min-height:54px}}
  </style>
</head>
<body><main class="cleaner-shell"><section class="cleaner-card">${content}</section></main></body>
</html>`;
}

async function prepareCleaningTimingConsent(data: {
  confirmation: any;
  reservation: any;
}) {
  const organizationId = data.reservation.property?.organizationId;
  if (!organizationId) return null;
  const snapshot = await materializeCleaningWorkSnapshot(
    createCleaningWorkSnapshotStore(prisma),
    {
      organizationId,
      propertyId: data.confirmation.propertyId,
      reservationId: data.confirmation.reservationId,
      staffMemberId: data.confirmation.staffMemberId,
      confirmationId: data.confirmation.id,
    },
  );
  if (!snapshot.work) return null;
  const checklist = await readOwnChecklist(prisma, { confirmationId: data.confirmation.id, staffMemberId: data.confirmation.staffMemberId, organizationId });
  let actionWindow: CleaningActionWindow | null = null;
  if (!snapshot.work.completionConfirmedAt) {
    try { actionWindow = await readCleaningActionWindow(prisma, snapshot.work); }
    catch { /* Keep the work visible, but never enable an unvalidated action. */ }
  }
  return {
    work: snapshot.work,
    actionWindow,
    checklist,
    timeZone: data.reservation.property?.timezone ?? "UTC",
    terms: buildCleaningTimingConsentSnapshot({
      scheduledStartAt: snapshot.work.scheduledStartAt,
      durationCommitmentMinutes: snapshot.work.durationCommitmentMinutes,
      startConfirmationGraceMinutes: snapshot.work.startConfirmationGraceMinutes,
      followupGraceMinutes: snapshot.work.followupGraceMinutes,
    }),
  };
}

/** Shared terminal view for the immediate POST response and later GET re-entry. */
function renderCleaningCompletedPage(
  completedAt: Date,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareCleaningTimingConsent>>>,
  language: StaffLanguage,
) {
  const es = language === "es";
  return cleanerPage(`
    <h2>${es ? "Limpieza completada" : "Cleaning completed"}</h2>
    <p>${es ? "Se registro que completaste la limpieza." : "Your cleaning completion has been recorded."}</p>
    <p><b>${es ? "Completada" : "Completed"}:</b> ${formatPropertyLocal(completedAt, prepared.timeZone, language)}</p>
    <p><b>${es ? "Inicio programado" : "Scheduled start"}:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone, language)}</p>
    <p><b>${es ? "Finalizacion comprometida" : "Committed completion"}:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
    ${renderCleaningChecklist({ ...prepared.checklist, editable: false }, "", language)}
    <p class="cleaner-note">${es ? "Pin&amp;Go registro tu declaracion; esto no certifica de forma independiente una inspeccion fisica." : "Pin&amp;Go recorded your declaration; this does not independently certify a physical inspection."}</p>
  `, language);
}

function renderTimingConsent(token: string, prepared: Awaited<ReturnType<typeof prepareCleaningTimingConsent>>, language: StaffLanguage) {
  const es = language === "es";
  if (!prepared) {
    return es
      ? "Disponibilidad de limpieza confirmada y acceso NFC preparado. No hay un compromiso de tiempo de limpieza configurado para esta asignacion."
      : "Cleaning availability confirmed and NFC access prepared. No cleaning-time commitment is configured for this property assignment.";
  }
  if (prepared.work.timingConsentAcceptedAt) {
    if (prepared.work.completionConfirmedAt) {
      return renderCleaningCompletedPage(prepared.work.completionConfirmedAt, prepared, language);
    }
    if (prepared.work.startConfirmedAt) {
      return cleanerPage(`
        <h2>${es ? "Limpieza en progreso" : "Cleaning in progress"}</h2>
        <p>${es ? "El inicio de tu limpieza ya fue registrado." : "Your cleaning start has already been recorded."}</p>
        <p><b>${es ? "Iniciada" : "Started"}:</b> ${formatPropertyLocal(prepared.work.startConfirmedAt, prepared.timeZone, language)}</p>
        <p><b>${es ? "Finalizacion comprometida" : "Committed completion"}:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
        ${renderCleaningChecklist(prepared.checklist, token, language)}
        ${renderCleaningActionButton({ token, action: "complete", window: prepared.actionWindow, startedAt: prepared.work.startConfirmedAt, language, blockedReason: checklistBlockReason(prepared.checklist, language) })}
      `, language);
    }
    return cleanerPage(`
      <h2>${es ? "Horario de limpieza confirmado" : "Cleaning timing confirmed"}</h2>
      <p>${es ? "Tu disponibilidad y compromiso de tiempo de limpieza estan confirmados." : "Your availability and cleaning-time commitment are confirmed."}</p>
      <p><b>${es ? "Inicio programado" : "Scheduled start"}:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone, language)}</p>
      <p><b>${es ? "Duracion estandar" : "Standard duration"}:</b> ${prepared.terms.durationCommitmentMinutes} ${es ? "minutos" : "minutes"}</p>
      <p><b>${es ? "Finalizacion comprometida" : "Committed completion"}:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
      ${renderCleaningChecklist(prepared.checklist, token, language)}
      ${cancelForm(token, language)}
      ${renderCleaningActionButton({ token, action: "start", window: prepared.actionWindow, startedAt: null, language })}
      <p class="cleaner-note">${es ? "Usa este boton cuando realmente comiences a limpiar. No cambia la hora comprometida de finalizacion ni la ventana de acceso NFC." : "Use this when you actually begin cleaning. It does not change the committed completion time or NFC access window."}</p>
    `, language);
  }
  return cleanerPage(`
      <h2>${es ? "Compromiso de horario de limpieza" : "Cleaning timing commitment"}</h2>
      <p>${es ? "Tu disponibilidad esta confirmada y Pin&Go continua gestionando tu acceso NFC." : "Your availability is confirmed and your NFC access remains handled by Pin&Go."}</p>
      <p><b>${es ? "Inicio programado" : "Scheduled start"}:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone, language)}</p>
      <p><b>${es ? "Duracion estandar" : "Standard duration"}:</b> ${prepared.terms.durationCommitmentMinutes} ${es ? "minutos" : "minutes"}</p>
      <p><b>${es ? "Confirma el inicio antes de" : "Confirm start by"}:</b> ${formatPropertyLocal(prepared.terms.startConfirmationDueAt, prepared.timeZone, language)}</p>
      <p><b>${es ? "Finalizacion comprometida" : "Committed completion"}:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
      <p><b>${es ? "Seguimiento comienza despues de" : "Follow-up begins after"}:</b> ${formatPropertyLocal(prepared.terms.followupAttentionAt, prepared.timeZone, language)}</p>
      <form method="POST" action="/cleaning/confirm/${token}/timing-consent">
        <button class="cleaner-action">${es ? "Acepto este horario y compromiso de tiempo de limpieza" : "I accept this cleaning schedule and time commitment"}</button>
      </form>
      ${cancelForm(token, language)}`, language);
}

async function runCompleteFlowAuditAfterCleaningConfirmation(
  reservationId: string
) {
  try {
    const completeFlowAuditResult =
      await auditReservationCompleteFlowSafe(reservationId, prisma);

    if (completeFlowAuditResult) {
      console.log("[CLEANING_CONFIRM_COMPLETE_FLOW_AUDIT_RESULT]", {
        reservationId: completeFlowAuditResult.reservationId,
        propertyId: completeFlowAuditResult.propertyId,
        organizationId: completeFlowAuditResult.organizationId,
        completeFlowStatus: completeFlowAuditResult.completeFlowStatus,
        failedChecks: completeFlowAuditResult.failedChecks.map(
          (check) => check.rule
        ),
        warningChecks: completeFlowAuditResult.warningChecks.map(
          (check) => check.rule
        ),
      });
    }
  } catch (auditError: any) {
    console.error("[CLEANING_CONFIRM_COMPLETE_FLOW_AUDIT_ERROR]", {
      reservationId,
      error: auditError?.message ?? auditError,
    });
  }
}

// GET /cleaning/confirm/:token
cleaningConfirmRouter.get("/cleaning/confirm/:token", async (req, res) => {
    let language: StaffLanguage = "en";
  try {
    const token = String(req.params.token ?? "");
    const data = await loadConfirmationData(token);
      language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);

    if (!data) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    const { confirmation, reservation, staffMember, invalidData } = data;
    language = resolveStaffLanguage(staffMember?.preferredLanguage);

       if (invalidData || !reservation || !staffMember) {
      return res.status(404).send(
        language === "es" ? "Los datos de confirmación de limpieza están incompletos." : "Cleaning confirmation data is incomplete."
      );
    }

    if (
      reservation.status ===
      ReservationStatus.CANCELLED
    ) {
      return sendCancelledCleaningRequestResponse(
        res,
        language
      );
    }

   if (
  reservation.property?.cleaningNfcEnabled !== true
) {
  console.log(
    "[CLEANING_CONFIRM_VIEW_SKIPPED]",
    {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      reason: "CLEANING_NFC_DISABLED",
    }
  );

  return sendCleaningNfcDisabledResponse(
    res,
    language
  );
}

    if (confirmation.status === "CANCELLED") return res.status(410).send(cleanerPage(`<p>${language === "es" ? "Esta limpieza fue cancelada por el cleaner." : "This cleaning was cancelled by the cleaner."}</p>`, language));
    if (confirmation.status === "EXPIRED") {
      return sendExpiredCleaningRequestResponse(res, language);
    }

    if (confirmation.status === "CONFIRMED") {
  const cleanerAccessResult =
    await ensureCleanerNfcAccessForConfirmedCleaning({
      prisma,
      reservationId: confirmation.reservationId,
      confirmationId: confirmation.id,
      trigger: "CLEANER_CONFIRMATION",
    });

  if (!cleanerAccessResult.ok) {
    console.error("[CLEANING_CONFIRM_ALREADY_CONFIRMED_ACCESS_ESCALATED]", {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      reason: cleanerAccessResult.reason,
      error: cleanerAccessResult.error,
    });

    return res.status(202).send(
      language === "es" ? "La limpieza ya está confirmada. Pin&Go todavía no pudo verificar el acceso NFC automáticamente; se notificó la incidencia en Mission Control." : "Cleaning already confirmed. Pin&Go could not verify NFC access automatically yet, so the issue was escalated in Mission Control."
    );
  }

  const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
  return res.send(renderTimingConsent(token, prepared, language));
}
    if (confirmation.status === "DECLINED") {
      return res.send(language === "es" ? "Esta solicitud de limpieza ya fue rechazada." : "This cleaning request was already declined.");
    }

    const propertyName = reservation.property?.name ?? "Property";
    const staffName = staffMember.fullName ?? "Cleaner";

    const es = language === "es";
    return res.send(cleanerPage(`
      <h2>${es ? "Solicitud de limpieza Pin&amp;Go" : "Pin&amp;Go Cleaning Request"}</h2>
      <p><b>${es ? "Personal de limpieza" : "Cleaner"}:</b> ${staffName}</p>
      <p><b>${es ? "Propiedad" : "Property"}:</b> ${propertyName}</p>
      <form method="POST" action="/cleaning/confirm/${token}/confirm">
        <button class="cleaner-action">${es ? "Confirmar disponibilidad" : "Confirm availability"}</button>
      </form>
      <form method="POST" action="/cleaning/confirm/${token}/decline">
        <button class="cleaner-action cleaner-action-secondary">${es ? "No estoy disponible" : "I am not available"}</button>
      </form>
    `, language));
  } catch (e: any) {
    return res.status(500).send(language === "es" ? "No se pudo cargar la confirmación. Inténtalo de nuevo." : "Failed to load confirmation.");
  }
});

// POST /cleaning/confirm/:token/confirm
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/confirm",
  async (req, res) => {
    let language: StaffLanguage = "en";
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);

      if (!data) {
        return res.status(404).send("Invalid or expired cleaning confirmation link.");
      }

      const { confirmation, reservation, staffMember, invalidData } = data;
      language = resolveStaffLanguage(staffMember?.preferredLanguage);

          if (invalidData || !reservation || !staffMember) {
        return res.status(404).send(
          language === "es" ? "Los datos de confirmación de limpieza están incompletos." : "Cleaning confirmation data is incomplete."
        );
      }

      if (
        reservation.status ===
        ReservationStatus.CANCELLED
      ) {
        return sendCancelledCleaningRequestResponse(
          res,
          language
        );
      }

     if (
  reservation.property?.cleaningNfcEnabled !== true
) {
  console.log(
    "[CLEANING_CONFIRM_ACTION_SKIPPED]",
    {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      action: "CONFIRM",
      reason: "CLEANING_NFC_DISABLED",
    }
  );

  return sendCleaningNfcDisabledResponse(
    res,
    language
  );
}

      if (confirmation.status === "CANCELLED") return res.status(410).send(cleanerPage(`<p>${language === "es" ? "Esta limpieza fue cancelada por el cleaner." : "This cleaning was cancelled by the cleaner."}</p>`, language));
    if (confirmation.status === "EXPIRED") {
        return sendExpiredCleaningRequestResponse(res, language);
      }

      if (confirmation.status === "CONFIRMED") {
        return res.send(language === "es" ? "La limpieza ya está confirmada. Gracias." : "Cleaning already confirmed. Thank you.");
      }

      if (confirmation.status === "DECLINED") {
        return res.status(409).send(language === "es" ? "Esta solicitud ya fue rechazada." : "This request was already declined.");
      }

      await acceptCleaningOffer(prisma, { confirmationId: confirmation.id, staffMemberId: staffMember.id, organizationId: staffMember.organizationId });

const cleanerAccessResult =
  await ensureCleanerNfcAccessForConfirmedCleaning({
    prisma,
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    trigger: "CLEANER_CONFIRMATION",
  });

if (
  cleanerAccessResult.skipped &&
  cleanerAccessResult.reason ===
    "CLEANING_NFC_DISABLED"
) {
  console.log(
    "[CLEANING_CONFIRM_ACCESS_SKIPPED]",
    {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      reason: cleanerAccessResult.reason,
    }
  );

  return sendCleaningNfcDisabledResponse(
    res,
    language
  );
}

if (!cleanerAccessResult.ok) {
  console.error("[CLEANING_CONFIRM_ACCESS_ESCALATED]", {
    reservationId: confirmation.reservationId,
    propertyId: confirmation.propertyId,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    reason: cleanerAccessResult.reason,
    error: cleanerAccessResult.error,
  });

  return res.status(202).send(
    language === "es" ? "Limpieza confirmada. Pin&Go registró tu disponibilidad, pero todavía no pudo activar el acceso NFC automáticamente. Se notificó la incidencia en Mission Control." : "Cleaning confirmed. Pin&Go recorded your availability, but NFC access could not be activated automatically yet. The issue was escalated in Mission Control."
  );
}

await runCompleteFlowAuditAfterCleaningConfirmation(
  confirmation.reservationId
);

const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
return res.send(renderTimingConsent(token, prepared, language));
     
    } catch (e: any) {
      if (e instanceof CleaningReassignmentError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "La oferta o el horario ya no permiten esta acción. Actualiza la limpieza para revisarla." : "The offer or schedule no longer permits this action. Refresh the cleaning to review it."}</p>`, language));
      console.error("[CLEANING_CONFIRM_CONFIRM_ERROR]", e);

      return res.status(500).send(language === "es" ? "No se pudo confirmar la limpieza. Inténtalo de nuevo." : "Failed to confirm cleaning.");
    }
  }
);

// POST /cleaning/confirm/:token/timing-consent
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/timing-consent",
  async (req, res) => {
    let language: StaffLanguage = "en";
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send(language === "es" ? "Los datos de confirmación de limpieza están incompletos." : "Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation, staffMember } = data;
      language = resolveStaffLanguage(staffMember.preferredLanguage);
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res, language);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res, language);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send(language === "es" ? "Confirma tu disponibilidad antes de aceptar el compromiso de horario." : "Confirm cleaning availability before accepting the timing commitment.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared) {
        return res.status(409).send(language === "es" ? "No hay un compromiso de horario configurado para esta asignación." : "No cleaning-time commitment is configured for this property assignment.");
      }
      const accepted = await acceptCleaningTimingConsent(prisma, {
        workId: prepared.work.id,
        reservationId: confirmation.reservationId,
        staffMemberId: confirmation.staffMemberId,
        confirmationId: confirmation.id,
      });
      const es = language === "es";
      return res.send(cleanerPage(`
          <h2>${es ? "Compromiso de horario de limpieza aceptado" : "Cleaning timing commitment accepted"}</h2>
          <p><b>${es ? "Inicio programado" : "Scheduled start"}:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone, language)}</p>
          <p><b>${es ? "Finalizacion comprometida" : "Committed completion"}:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
          <p>${es ? "Tu aceptacion fue registrada a las" : "Your acceptance was recorded at"} ${formatPropertyLocal(accepted.timingConsentAcceptedAt!, prepared.timeZone, language)}.</p>
          ${renderCleaningChecklist(prepared.checklist, token, language)}
      ${cancelForm(token, language)}
      ${renderCleaningActionButton({ token, action: "start", window: prepared.actionWindow, startedAt: null, language })}
          <p class="cleaner-note">${es ? "Este boton registra tu declaracion de inicio. No cambia la hora comprometida de finalizacion ni la ventana de acceso NFC." : "This button records your declaration of starting the cleaning. It does not change the committed completion time or NFC access window."}</p>
      `, language));
    } catch (e: any) {
      if (e instanceof CleaningReassignmentError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "La oferta o el horario ya no permiten esta acción. Actualiza la limpieza para revisarla." : "The offer or schedule no longer permits this action. Refresh the cleaning to review it."}</p>`, language));
      console.error("[CLEANING_TIMING_CONSENT_ERROR]", e);
      return res.status(409).send(language === "es" ? "No se pudo aceptar el compromiso de horario. Revisa la solicitud e inténtalo de nuevo." : "Failed to accept cleaning timing commitment.");
    }
  }
);

// POST /cleaning/confirm/:token/start
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/start",
  async (req, res) => {
    let language: StaffLanguage = "en";
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send(language === "es" ? "Los datos de confirmación de limpieza están incompletos." : "Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation, staffMember } = data;
      language = resolveStaffLanguage(staffMember.preferredLanguage);
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res, language);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res, language);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send(language === "es" ? "Confirma tu disponibilidad antes de registrar el inicio de la limpieza." : "Confirm cleaning availability before recording the cleaning start.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared?.work.timingConsentAcceptedAt) {
        return res.status(409).send(language === "es" ? "Acepta el compromiso de horario antes de registrar el inicio de la limpieza." : "Accept the cleaning timing commitment before recording the cleaning start.");
      }
      const started = await confirmCleaningStart(prisma, {
        workId: prepared.work.id,
        reservationId: confirmation.reservationId,
        staffMemberId: confirmation.staffMemberId,
        confirmationId: confirmation.id,
      });
      const terms = buildCleaningTimingConsentSnapshot({
        scheduledStartAt: prepared.work.scheduledStartAt,
        durationCommitmentMinutes: prepared.work.durationCommitmentMinutes,
        startConfirmationGraceMinutes: prepared.work.startConfirmationGraceMinutes,
        followupGraceMinutes: prepared.work.followupGraceMinutes,
      });
      const es = language === "es";
      return res.send(cleanerPage(`
          <h2>${es ? "Inicio de limpieza registrado" : "Cleaning start recorded"}</h2>
          <p>${es ? "Inicio confirmado a las" : "Start confirmed at"} ${formatPropertyLocal(started.startConfirmedAt!, prepared.timeZone, language)}.</p>
          <p><b>${es ? "La finalizacion comprometida permanece" : "Committed completion remains"}:</b> ${formatPropertyLocal(terms.scheduledCompletionAt, prepared.timeZone, language)}</p>
          ${renderCleaningChecklist({ ...prepared.checklist, editable: true }, token, language)}
          ${renderCleaningActionButton({ token, action: "complete", window: prepared.actionWindow, startedAt: started.startConfirmedAt, language, blockedReason: checklistBlockReason(prepared.checklist, language) })}
          <p class="cleaner-note">${es ? "Esto registra tu declaracion de finalizacion. No certifica de forma independiente una inspeccion ni cambia el acceso NFC." : "This records your completion declaration. It does not independently certify an inspection or change NFC access."}</p>
      `, language));
    } catch (e: any) {
      if (e instanceof CleaningReassignmentError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "La oferta o el horario ya no permiten esta acción. Actualiza la limpieza para revisarla." : "The offer or schedule no longer permits this action. Refresh the cleaning to review it."}</p>`, language));
      if (e instanceof CleaningActionWindowError) return sendCleaningActionWindowFailure(res, e, language);
      console.error("[CLEANING_START_CONFIRM_ERROR]", e);
      return res.status(409).send(language === "es" ? "No se pudo registrar el inicio. Revisa la solicitud e inténtalo de nuevo." : "Failed to record cleaning start.");
    }
  }
);

// POST /cleaning/confirm/:token/complete
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/complete",
  async (req, res) => {
    let language: StaffLanguage = "en";
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      language = resolveStaffLanguage(data?.staffMember?.preferredLanguage);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send(language === "es" ? "Los datos de confirmación de limpieza están incompletos." : "Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation, staffMember } = data;
      language = resolveStaffLanguage(staffMember.preferredLanguage);
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res, language);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res, language);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send(language === "es" ? "Confirma tu disponibilidad antes de registrar la finalización." : "Confirm cleaning availability before recording completion.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared?.work.timingConsentAcceptedAt) {
        return res.status(409).send(language === "es" ? "Acepta el compromiso de horario antes de registrar la finalización." : "Accept the cleaning timing commitment before recording completion.");
      }
      const completed = await confirmCleaningCompletion(prisma, {
        workId: prepared.work.id,
        reservationId: confirmation.reservationId,
        staffMemberId: confirmation.staffMemberId,
        confirmationId: confirmation.id,
      });
      await resolveCleaningHostAttention({
        prisma,
        cleaningWorkId: prepared.work.id,
        occurredAt: completed.completionConfirmedAt!,
      });
      await prisma.cleaningHostAttentionNotice.updateMany({
        where: { cleaningWorkId: prepared.work.id, status: { in: ["QUEUED", "FAILED"] } },
        data: { status: "OBSOLETE", lastError: "CLEANER_COMPLETION_CONFIRMED" },
      });
      return res.send(renderCleaningCompletedPage(
        completed.completionConfirmedAt!,
        prepared,
        language,
      ));
    } catch (e: any) {
      if (e instanceof CleaningReassignmentError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "La oferta o el horario ya no permiten esta acción. Actualiza la limpieza para revisarla." : "The offer or schedule no longer permits this action. Refresh the cleaning to review it."}</p>`, language));
      if (e instanceof CleaningActionWindowError) return sendCleaningActionWindowFailure(res, e, language);
      if (e instanceof CleaningChecklistError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "Completa los puntos obligatorios del checklist antes de finalizar." : "Complete the required checklist items before finishing."}</p>`, language));
      console.error("[CLEANING_COMPLETION_CONFIRM_ERROR]", e);
      return res.status(409).send(language === "es" ? "No se pudo registrar la finalización. Revisa la solicitud e inténtalo de nuevo." : "Failed to record cleaning completion.");
    }
  }
);

// POST /cleaning/confirm/:token/decline
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/decline",
  async (req, res) => {
    let language: StaffLanguage = "en";
    try {
      const token = String(req.params.token ?? "");

      const confirmation = await prisma.cleaningConfirmation.findUnique({
        where: { token },
      });

      if (!confirmation) {
        return res
          .status(404)
          .send("Invalid or expired cleaning confirmation link.");
      }

      const declineStaff = await prisma.staffMember.findUnique({
        where: { id: confirmation.staffMemberId },
        select: { preferredLanguage: true },
      });
      language = resolveStaffLanguage(declineStaff?.preferredLanguage);

      if (confirmation.status === "CONFIRMED") {
        return res
          .status(409)
          .send(language === "es" ? "Esta solicitud ya fue confirmada." : "This request was already confirmed.");
      }

     const reservation =
  await prisma.reservation.findUnique({
    where: {
      id: confirmation.reservationId,
    },
    include: {
      property: true,
    },
  });
            if (!reservation) {
        return res
          .status(404)
          .send(language === "es" ? "No se encontro la reservacion." : "Reservation not found.");
      }

      if (
        reservation.status ===
        ReservationStatus.CANCELLED
      ) {
        return sendCancelledCleaningRequestResponse(
          res,
          language
        );
      }

      if (
  reservation.property?.cleaningNfcEnabled !== true
) {
  console.log(
    "[CLEANING_CONFIRM_ACTION_SKIPPED]",
    {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      confirmationId: confirmation.id,
      staffMemberId: confirmation.staffMemberId,
      action: "DECLINE",
      reason: "CLEANING_NFC_DISABLED",
    }
  );

  return sendCleaningNfcDisabledResponse(
    res,
    language
  );
}

      if (confirmation.status === "CANCELLED") return res.status(410).send(cleanerPage(`<p>${language === "es" ? "Esta limpieza fue cancelada por el cleaner." : "This cleaning was cancelled by the cleaner."}</p>`, language));
    if (confirmation.status === "EXPIRED") {
        return sendExpiredCleaningRequestResponse(res, language);
      }

      const withdrawn = await withdrawCleaning(prisma, { confirmationId: confirmation.id, staffMemberId: confirmation.staffMemberId, organizationId: reservation.property.organizationId }, "decline");
      return res.send(cleanerPage(`<p>${withdrawn.nextConfirmationId
        ? (language === "es" ? "Oferta rechazada. Pin&Go continuará con el siguiente respaldo disponible." : "Offer declined. Pin&Go will continue with the next available backup.")
        : (language === "es" ? "Oferta rechazada. No hay un respaldo viable disponible." : "Offer declined. No viable backup is available.")}</p>`, language));
    } catch (e: any) {
      if (e instanceof CleaningReassignmentError) return res.status(e.status).send(cleanerPage(`<p role="alert">${language === "es" ? "La oferta o el horario ya no permiten esta acción. Actualiza la limpieza para revisarla." : "The offer or schedule no longer permits this action. Refresh the cleaning to review it."}</p>`, language));
      console.error(
        "[CLEANING_CONFIRM_DECLINE_ERROR]",
        e
      );

      return res
        .status(500)
        .send(
          language === "es" ? "No se pudo rechazar la limpieza. Inténtalo de nuevo." : "Failed to decline cleaning."
        );
    }
  }
);
