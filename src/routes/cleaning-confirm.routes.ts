import { Router } from "express";
import {
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "../services/cleaner-access-autopilot.service";
import { auditReservationCompleteFlowSafe } from "../services/reservation-complete-flow-audit.service";
import {
  synchronizeCleaningCoverageOperationalIssue,
} from "../services/cleaning-operational.service";
import type {
  CleaningCoverageOperationalState,
} from "../services/cleaning-operational.service";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

async function synchronizeCleaningCoverageSafe(input: {
  reservationId: string;
  confirmationId?: string | null;
  staffMemberId?: string | null;
  state: CleaningCoverageOperationalState;
  attemptedCleanerCount?: number | null;
  reason?: string | null;
  occurredAt: Date;
}) {
  try {
    await synchronizeCleaningCoverageOperationalIssue({
      prisma,
      ...input,
    });
  } catch (operationalError) {
    console.error(
      "[CLEANING_CONFIRM_OPERATIONAL_SYNC_ERROR]",
      {
        reservationId: input.reservationId,
        confirmationId:
          input.confirmationId ?? null,
        staffMemberId:
          input.staffMemberId ?? null,
        state: input.state,
        error:
          operationalError instanceof Error
            ? operationalError.stack ||
              operationalError.message
            : String(operationalError),
      }
    );
  }
}

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
      await synchronizeCleaningCoverageSafe({
        reservationId: reservation.id,
        confirmationId: confirmation.id,
        staffMemberId: confirmation.staffMemberId,
        state: "SUPERSEDED",
        reason: "RESERVATION_CANCELLED",
        occurredAt: new Date(),
      });

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

  await synchronizeCleaningCoverageSafe({
    reservationId: reservation.id,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    state: "SUPERSEDED",
    reason: "CLEANING_NFC_DISABLED",
    occurredAt: new Date(),
  });

  return sendCleaningNfcDisabledResponse(
    res
  );
}

    if (confirmation.status === "CONFIRMED") {
  await synchronizeCleaningCoverageSafe({
    reservationId: confirmation.reservationId,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    state: "CONFIRMED",
    reason: "CLEANER_ALREADY_CONFIRMED",
    occurredAt: new Date(),
  });

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
        await synchronizeCleaningCoverageSafe({
          reservationId: reservation.id,
          confirmationId: confirmation.id,
          staffMemberId: confirmation.staffMemberId,
          state: "SUPERSEDED",
          reason: "RESERVATION_CANCELLED",
          occurredAt: new Date(),
        });

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

  await synchronizeCleaningCoverageSafe({
    reservationId: reservation.id,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    state: "SUPERSEDED",
    reason: "CLEANING_NFC_DISABLED",
    occurredAt: new Date(),
  });

  return sendCleaningNfcDisabledResponse(
    res
  );
}

      if (confirmation.status === "CONFIRMED") {
        await synchronizeCleaningCoverageSafe({
          reservationId: confirmation.reservationId,
          confirmationId: confirmation.id,
          staffMemberId: confirmation.staffMemberId,
          state: "CONFIRMED",
          reason: "CLEANER_ALREADY_CONFIRMED",
          occurredAt: new Date(),
        });

        return res.send("Cleaning already confirmed. Thank you.");
      }

      if (confirmation.status === "DECLINED") {
        return res.status(409).send("This request was already declined.");
      }

      const confirmedAt = new Date();
      const confirmationClaim =
        await prisma.cleaningConfirmation.updateMany({
          where: {
            id: confirmation.id,
            status: "PENDING",
          },
          data: {
            status: "CONFIRMED",
          },
        });

      if (confirmationClaim.count === 0) {
        const currentConfirmation =
          await prisma.cleaningConfirmation.findUnique({
            where: {
              id: confirmation.id,
            },
            select: {
              status: true,
            },
          });

        if (currentConfirmation?.status === "CONFIRMED") {
          await synchronizeCleaningCoverageSafe({
            reservationId: confirmation.reservationId,
            confirmationId: confirmation.id,
            staffMemberId: confirmation.staffMemberId,
            state: "CONFIRMED",
            reason: "CLEANER_ALREADY_CONFIRMED",
            occurredAt: confirmedAt,
          });

          return res.send("Cleaning already confirmed. Thank you.");
        }

        return res.status(409).send(
          "This cleaning request is no longer pending."
        );
      }

      await synchronizeCleaningCoverageSafe({
        reservationId: confirmation.reservationId,
        confirmationId: confirmation.id,
        staffMemberId: confirmation.staffMemberId,
        state: "CONFIRMED",
        reason: "CLEANER_CONFIRMED",
        occurredAt: confirmedAt,
      });

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

return res.send(
  "Cleaning confirmed. Pin&Go prepared your NFC access for the cleaning window."
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

      if (confirmation.status === "DECLINED") {
        return res.send(
          "This cleaning request was already declined."
        );
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
        await synchronizeCleaningCoverageSafe({
          reservationId: reservation.id,
          confirmationId: confirmation.id,
          staffMemberId: confirmation.staffMemberId,
          state: "SUPERSEDED",
          reason: "RESERVATION_CANCELLED",
          occurredAt: new Date(),
        });

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

  await synchronizeCleaningCoverageSafe({
    reservationId: reservation.id,
    confirmationId: confirmation.id,
    staffMemberId: confirmation.staffMemberId,
    state: "SUPERSEDED",
    reason: "CLEANING_NFC_DISABLED",
    occurredAt: new Date(),
  });

  return sendCleaningNfcDisabledResponse(
    res
  );
}

      const declinedAt = new Date();
      const allAttempts =
        await prisma.cleaningConfirmation.findMany({
          where: {
            reservationId: confirmation.reservationId,
          },
          select: {
            staffMemberId: true,
          },
        });

      const excludeStaffIds = allAttempts.map(
        (attempt) => attempt.staffMemberId
      );

      const { selectNextStaffForProperty } = await import(
        "../services/staff-selection.service"
      );

      const nextStaff =
        await selectNextStaffForProperty({
          propertyId: confirmation.propertyId,
          excludeStaffIds,
        });

      const crypto = nextStaff
        ? await import("crypto")
        : null;

      const declineResult =
        await prisma.$transaction(async (tx) => {
          const declineClaim =
            await tx.cleaningConfirmation.updateMany({
              where: {
                id: confirmation.id,
                status: "PENDING",
              },
              data: {
                status: "DECLINED",
              },
            });

          if (declineClaim.count === 0) {
            return {
              claimed: false as const,
              nextConfirmation: null,
            };
          }

          if (!nextStaff || !crypto) {
            return {
              claimed: true as const,
              nextConfirmation: null,
            };
          }

          const existingPendingOther =
            await tx.cleaningConfirmation.findFirst({
              where: {
                reservationId:
                  confirmation.reservationId,
                status: "PENDING",
                id: {
                  not: confirmation.id,
                },
              },
              orderBy: {
                createdAt: "desc",
              },
            });

          if (existingPendingOther) {
            return {
              claimed: true as const,
              nextConfirmation:
                existingPendingOther,
            };
          }

          const nextConfirmation =
            await tx.cleaningConfirmation.create({
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

          return {
            claimed: true as const,
            nextConfirmation,
          };
        });

      if (!declineResult.claimed) {
        const currentConfirmation =
          await prisma.cleaningConfirmation.findUnique({
            where: {
              id: confirmation.id,
            },
            select: {
              status: true,
            },
          });

        if (currentConfirmation?.status === "DECLINED") {
          return res.send(
            "This cleaning request was already declined."
          );
        }

        return res.status(409).send(
          "This cleaning request is no longer pending."
        );
      }

      if (!nextStaff) {
        await synchronizeCleaningCoverageSafe({
          reservationId: confirmation.reservationId,
          confirmationId: confirmation.id,
          staffMemberId: confirmation.staffMemberId,
          state: "NO_BACKUP_AVAILABLE",
          attemptedCleanerCount: excludeStaffIds.length,
          reason: "CLEANER_DECLINED_NO_BACKUP",
          occurredAt: declinedAt,
        });

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

      const nextConfirmation =
        declineResult.nextConfirmation;

      if (!nextConfirmation) {
        throw new Error(
          "CLEANING_BACKUP_CONFIRMATION_NOT_CREATED"
        );
      }

      await synchronizeCleaningCoverageSafe({
        reservationId: confirmation.reservationId,
        confirmationId: nextConfirmation.id,
        staffMemberId: nextConfirmation.staffMemberId,
        state: "BACKUP_ASSIGNED",
        attemptedCleanerCount: excludeStaffIds.length,
        reason: "CLEANER_DECLINED_BACKUP_ASSIGNED",
        occurredAt: declinedAt,
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