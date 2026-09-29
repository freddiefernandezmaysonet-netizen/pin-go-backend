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
import { resolveCleaningHostAttention } from "../services/cleaning-followup-host-attention.service.js";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

function sendCancelledCleaningRequestResponse(
  res: any
) {
  return res.status(410).send(
    "This cleaning request is no longer active because the reservation was cancelled. No cleaning or access action is required."
  );
}

function sendCleaningNfcDisabledResponse(
  res: any
) {
  return res.status(410).send(
    "This cleaning access request is no longer active because Cleaning NFC is disabled for this property. No confirmation or access action is required."
  );
}

function sendExpiredCleaningRequestResponse(
  res: any
) {
  return res.status(410).send(
    "This cleaning request is no longer active because Pin&Go assigned it to another cleaner. No action is required."
  );
}

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

function formatPropertyLocal(value: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
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

function cleanerPage(content: string) {
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <style>
    *{box-sizing:border-box} body{margin:0;background:#f8fafc;color:#111827;font-family:Arial,sans-serif;font-size:17px;line-height:1.55}
    .cleaner-shell{width:min(100%,680px);margin:0 auto;padding:24px 18px 40px}
    .cleaner-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;box-shadow:0 8px 28px rgba(15,23,42,.06)}
    h2{font-size:26px;line-height:1.2;margin:0 0 20px} p{margin:0 0 14px} b{font-weight:750}
    .cleaner-action{display:block;width:100%;min-height:52px;padding:14px 18px;margin-top:20px;border:0;border-radius:12px;background:#2563eb;color:#fff;font-size:17px;font-weight:750;line-height:1.25;white-space:normal}
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
  return {
    work: snapshot.work,
    timeZone: data.reservation.property?.timezone ?? "UTC",
    terms: buildCleaningTimingConsentSnapshot({
      scheduledStartAt: snapshot.work.scheduledStartAt,
      durationCommitmentMinutes: snapshot.work.durationCommitmentMinutes,
      startConfirmationGraceMinutes: snapshot.work.startConfirmationGraceMinutes,
      followupGraceMinutes: snapshot.work.followupGraceMinutes,
    }),
  };
}

function renderTimingConsent(token: string, prepared: Awaited<ReturnType<typeof prepareCleaningTimingConsent>>) {
  if (!prepared) {
    return "Cleaning availability confirmed and NFC access prepared. No cleaning-time commitment is configured for this property assignment.";
  }
  if (prepared.work.timingConsentAcceptedAt) {
    return `Cleaning availability and timing commitment already confirmed. Scheduled start: ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone)}. Committed completion: ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone)}.`;
  }
  return cleanerPage(`\n      <h2>Cleaning timing commitment</h2>
      <p>Your availability is confirmed and your NFC access remains handled by Pin&Go.</p>
      <p><b>Scheduled start:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone)}</p>
      <p><b>Standard duration:</b> ${prepared.terms.durationCommitmentMinutes} minutes</p>
      <p><b>Confirm start by:</b> ${formatPropertyLocal(prepared.terms.startConfirmationDueAt, prepared.timeZone)}</p>
      <p><b>Committed completion:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone)}</p>
      <p><b>Follow-up begins after:</b> ${formatPropertyLocal(prepared.terms.followupAttentionAt, prepared.timeZone)}</p>
      <form method="POST" action="/cleaning/confirm/${token}/timing-consent">
        <button class="cleaner-action">I accept this cleaning schedule and time commitment</button>\n      </form>`);
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
  try {
    const token = String(req.params.token ?? "");
    const data = await loadConfirmationData(token);

    if (!data) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    const { confirmation, reservation, staffMember, invalidData } = data;

       if (invalidData || !reservation || !staffMember) {
      return res.status(404).send(
        "Cleaning confirmation data is incomplete."
      );
    }

    if (
      reservation.status ===
      ReservationStatus.CANCELLED
    ) {
      return sendCancelledCleaningRequestResponse(
        res
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
    res
  );
}

    if (confirmation.status === "EXPIRED") {
      return sendExpiredCleaningRequestResponse(res);
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
      "Cleaning already confirmed. Pin&Go could not verify NFC access automatically yet, so the issue was escalated in Mission Control."
    );
  }

  const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
  return res.send(renderTimingConsent(token, prepared));
}
    if (confirmation.status === "DECLINED") {
      return res.send("This cleaning request was already declined.");
    }

    const propertyName = reservation.property?.name ?? "Property";
    const staffName = staffMember.fullName ?? "Cleaner";

    return res.send(`
      <html>
        <body style="font-family: Arial; padding: 24px;">
          <h2>Pin&Go Cleaning Request</h2>

          <p><b>Cleaner:</b> ${staffName}</p>
          <p><b>Property:</b> ${propertyName}</p>

          <form method="POST" action="/cleaning/confirm/${token}/confirm" style="margin-bottom:12px;">
            <button style="padding:12px 18px;background:#2563eb;color:white;border:0;border-radius:8px;">
              Confirm availability
            </button>
          </form>

          <form method="POST" action="/cleaning/confirm/${token}/decline">
            <button style="padding:12px 18px;background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;">
              I am not available
            </button>
          </form>
        </body>
      </html>
    `);
  } catch (e: any) {
    return res.status(500).send(e?.message ?? "Failed to load confirmation.");
  }
});

// POST /cleaning/confirm/:token/confirm
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/confirm",
  async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);

      if (!data) {
        return res.status(404).send("Invalid or expired cleaning confirmation link.");
      }

      const { confirmation, reservation, staffMember, invalidData } = data;

          if (invalidData || !reservation || !staffMember) {
        return res.status(404).send(
          "Cleaning confirmation data is incomplete."
        );
      }

      if (
        reservation.status ===
        ReservationStatus.CANCELLED
      ) {
        return sendCancelledCleaningRequestResponse(
          res
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
    res
  );
}

      if (confirmation.status === "EXPIRED") {
        return sendExpiredCleaningRequestResponse(res);
      }

      if (confirmation.status === "CONFIRMED") {
        return res.send("Cleaning already confirmed. Thank you.");
      }

      if (confirmation.status === "DECLINED") {
        return res.status(409).send("This request was already declined.");
      }

      const confirmTransition =
        await prisma.cleaningConfirmation.updateMany({
          where: {
            id: confirmation.id,
            status: "PENDING",
          },
          data: {
            status: "CONFIRMED",
          },
        });

      if (confirmTransition.count !== 1) {
        const currentConfirmation =
          await prisma.cleaningConfirmation.findUnique({
            where: { id: confirmation.id },
          });

        if (currentConfirmation?.status === "EXPIRED") {
          return sendExpiredCleaningRequestResponse(res);
        }

        if (currentConfirmation?.status === "CONFIRMED") {
          return res.send("Cleaning already confirmed. Thank you.");
        }

        if (currentConfirmation?.status === "DECLINED") {
          return res.status(409).send("This request was already declined.");
        }

        return res.status(409).send(
          "This cleaning request could not be confirmed because it is no longer actionable."
        );
      }

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
    res
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
    "Cleaning confirmed. Pin&Go recorded your availability, but NFC access could not be activated automatically yet. The issue was escalated in Mission Control."
  );
}

await runCompleteFlowAuditAfterCleaningConfirmation(
  confirmation.reservationId
);

const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
return res.send(renderTimingConsent(token, prepared));
     
    } catch (e: any) {
      console.error("[CLEANING_CONFIRM_CONFIRM_ERROR]", e);

      return res.status(500).send(e?.message ?? "Failed to confirm cleaning.");
    }
  }
);

// POST /cleaning/confirm/:token/timing-consent
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/timing-consent",
  async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send("Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation } = data;
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send("Confirm cleaning availability before accepting the timing commitment.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared) {
        return res.status(409).send("No cleaning-time commitment is configured for this property assignment.");
      }
      const accepted = await acceptCleaningTimingConsent(prisma, {
        workId: prepared.work.id,
        reservationId: confirmation.reservationId,
        staffMemberId: confirmation.staffMemberId,
        confirmationId: confirmation.id,
      });
      return res.send(cleanerPage(`\n          <h2>Cleaning timing commitment accepted</h2>
          <p><b>Scheduled start:</b> ${formatPropertyLocal(prepared.terms.scheduledStartAt, prepared.timeZone)}</p>
          <p><b>Committed completion:</b> ${formatPropertyLocal(prepared.terms.scheduledCompletionAt, prepared.timeZone)}</p>
          <p>Your acceptance was recorded at ${formatPropertyLocal(accepted.timingConsentAcceptedAt!, prepared.timeZone)}.</p>
          <form method="POST" action="/cleaning/confirm/${token}/start">
            <button class="cleaner-action">I started cleaning</button>\n          </form>\n          <p class="cleaner-note">This button records your declaration of starting the cleaning. It does not change the committed completion time or NFC access window.</p>\n      `));
    } catch (e: any) {
      console.error("[CLEANING_TIMING_CONSENT_ERROR]", e);
      return res.status(409).send(e?.message ?? "Failed to accept cleaning timing commitment.");
    }
  }
);

// POST /cleaning/confirm/:token/start
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/start",
  async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send("Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation } = data;
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send("Confirm cleaning availability before recording the cleaning start.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared?.work.timingConsentAcceptedAt) {
        return res.status(409).send("Accept the cleaning timing commitment before recording the cleaning start.");
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
      return res.send(cleanerPage(`\n          <h2>Cleaning start recorded</h2>
          <p>Start confirmed at ${formatPropertyLocal(started.startConfirmedAt!, prepared.timeZone)}.</p>
          <p><b>Committed completion remains:</b> ${formatPropertyLocal(terms.scheduledCompletionAt, prepared.timeZone)}</p>
          <form method="POST" action="/cleaning/confirm/${token}/complete">
            <button class="cleaner-action">I finished cleaning</button>\n          </form>\n          <p class="cleaner-note">This records your completion declaration. It does not independently certify an inspection or change NFC access.</p>\n      `));
    } catch (e: any) {
      console.error("[CLEANING_START_CONFIRM_ERROR]", e);
      return res.status(409).send(e?.message ?? "Failed to record cleaning start.");
    }
  }
);

// POST /cleaning/confirm/:token/complete
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/complete",
  async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      const data = await loadConfirmationData(token);
      if (!data || data.invalidData || !data.reservation || !data.staffMember) {
        return res.status(404).send("Cleaning confirmation data is incomplete.");
      }
      const { confirmation, reservation } = data;
      if (reservation.status === ReservationStatus.CANCELLED) {
        return sendCancelledCleaningRequestResponse(res);
      }
      if (reservation.property?.cleaningNfcEnabled !== true) {
        return sendCleaningNfcDisabledResponse(res);
      }
      if (confirmation.status !== "CONFIRMED") {
        return res.status(409).send("Confirm cleaning availability before recording completion.");
      }
      const prepared = await prepareCleaningTimingConsent({ confirmation, reservation });
      if (!prepared?.work.timingConsentAcceptedAt) {
        return res.status(409).send("Accept the cleaning timing commitment before recording completion.");
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
      return res.send(
        `Cleaning completion recorded at ${formatPropertyLocal(completed.completionConfirmedAt!, prepared.timeZone)}. Pin&Go recorded your declaration; this does not independently certify a physical inspection.`
      );
    } catch (e: any) {
      console.error("[CLEANING_COMPLETION_CONFIRM_ERROR]", e);
      return res.status(409).send(e?.message ?? "Failed to record cleaning completion.");
    }
  }
);

// POST /cleaning/confirm/:token/decline
cleaningConfirmRouter.post(
  "/cleaning/confirm/:token/decline",
  async (req, res) => {
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

      if (confirmation.status === "CONFIRMED") {
        return res
          .status(409)
          .send("This request was already confirmed.");
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
          .send("Reservation not found.");
      }

      if (
        reservation.status ===
        ReservationStatus.CANCELLED
      ) {
        return sendCancelledCleaningRequestResponse(
          res
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
    res
  );
}

      if (confirmation.status === "EXPIRED") {
        return sendExpiredCleaningRequestResponse(res);
      }

      const declineTransition =
        await prisma.cleaningConfirmation.updateMany({
          where: {
            id: confirmation.id,
            status: "PENDING",
          },
          data: {
            status: "DECLINED",
          },
        });

      if (declineTransition.count !== 1) {
        const currentConfirmation =
          await prisma.cleaningConfirmation.findUnique({
            where: { id: confirmation.id },
          });

        if (currentConfirmation?.status === "EXPIRED") {
          return sendExpiredCleaningRequestResponse(res);
        }

        if (currentConfirmation?.status === "CONFIRMED") {
          return res
            .status(409)
            .send("This request was already confirmed.");
        }

        if (currentConfirmation?.status === "DECLINED") {
          return res.send("This cleaning request was already declined.");
        }

        return res.status(409).send(
          "This cleaning request could not be declined because it is no longer actionable."
        );
      }

      const allAttempts = await prisma.cleaningConfirmation.findMany({
        where: {
          reservationId: confirmation.reservationId,
        },
        select: {
          staffMemberId: true,
        },
      });

      const excludeStaffIds = allAttempts.map(
        (a) => a.staffMemberId
      );

      const { selectNextStaffForProperty } = await import(
        "../services/staff-selection.service"
      );

      const nextStaff =
        await selectNextStaffForProperty({
          propertyId: confirmation.propertyId,
          excludeStaffIds,
        });

      if (!nextStaff) {
        console.warn(
          "[CLEANING_CONFIRM_DECLINE] no backup available",
          {
            reservationId: confirmation.reservationId,
            propertyId: confirmation.propertyId,
            excludeStaffIds,
          }
        );

        return res.send(
          "Cleaning declined. No backup cleaner is currently available."
        );
      }

      const crypto = await import("crypto");

      const nextConfirmation =
        await prisma.cleaningConfirmation.create({
          data: {
            reservationId:
              confirmation.reservationId,
            propertyId:
              confirmation.propertyId,
            staffMemberId: nextStaff.id,
            token: crypto.randomBytes(32).toString("hex"),
            status: "PENDING",
          },
        });

      console.log(
        "[CLEANING_CONFIRM_DECLINE] created backup confirmation",
        {
          reservationId:
            confirmation.reservationId,
          propertyId:
            confirmation.propertyId,
          declinedConfirmationId:
            confirmation.id,
          nextConfirmationId:
            nextConfirmation.id,
          nextStaffId: nextStaff.id,
        }
      );

      return res.send(
        "Cleaning declined. Pin&Go will notify the next available backup cleaner."
      );
    } catch (e: any) {
      console.error(
        "[CLEANING_CONFIRM_DECLINE_ERROR]",
        e
      );

      return res
        .status(500)
        .send(
          e?.message ??
            "Failed to decline cleaning."
        );
    }
  }
);
