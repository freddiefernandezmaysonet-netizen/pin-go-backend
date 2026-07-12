import { Router } from "express";
import {
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "../services/cleaner-access-autopilot.service";
import { auditReservationCompleteFlowSafe } from "../services/reservation-complete-flow-audit.service";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

function sendCancelledCleaningRequestResponse(
  res: any
) {
  return res.status(410).send(
    "This cleaning request is no longer active because the reservation was cancelled. No cleaning or access action is required."
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

  return res.send(
    "Cleaning already confirmed. Pin&Go verified your NFC access for the cleaning window."
  );
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

      if (confirmation.status === "CONFIRMED") {
        return res.send("Cleaning already confirmed. Thank you.");
      }

      if (confirmation.status === "DECLINED") {
        return res.status(409).send("This request was already declined.");
      }

      await prisma.cleaningConfirmation.update({
  where: {
    id: confirmation.id,
  },
  data: {
    status: "CONFIRMED",
  },
});

const cleanerAccessResult =
  await ensureCleanerNfcAccessForConfirmedCleaning({
    prisma,
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    trigger: "CLEANER_CONFIRMATION",
  });

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

return res.send(
  "Cleaning confirmed. Pin&Go prepared your NFC access for the cleaning window."
);
      return res.send(
        "Cleaning confirmed. Pin&Go will activate your NFC access during the cleaning window."
      );
    } catch (e: any) {
      console.error("[CLEANING_CONFIRM_CONFIRM_ERROR]", e);

      return res.status(500).send(e?.message ?? "Failed to confirm cleaning.");
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

      const reservation = await prisma.reservation.findUnique({
        where: {
          id: confirmation.reservationId,
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

      await prisma.cleaningConfirmation.update({
        where: { id: confirmation.id },
        data: {
          status: "DECLINED",
        },
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