import { Router } from "express";
import {
  PrismaClient,
  StaffAccessMethod,
  StaffAssignmentStatus,
  NfcAssignmentRole,
} from "@prisma/client";

import { computeCleaningWindowPR } from "../services/cleaningWindow.service";
import { assignNfcCards } from "../services/nfc.service";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

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
      return res.status(404).send("Cleaning confirmation data is incomplete.");
    }

    if (confirmation.status === "CONFIRMED") {
      return res.send("Cleaning already confirmed. Thank you.");
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
cleaningConfirmRouter.post("/cleaning/confirm/:token/confirm", async (req, res) => {
  try {
    const token = String(req.params.token ?? "");
    const data = await loadConfirmationData(token);

    if (!data) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    const { confirmation, reservation, staffMember, invalidData } = data;

    if (invalidData || !reservation || !staffMember) {
      return res.status(404).send("Cleaning confirmation data is incomplete.");
    }

    if (confirmation.status === "CONFIRMED") {
      return res.send("Cleaning already confirmed. Thank you.");
    }

    if (confirmation.status === "DECLINED") {
      return res.status(409).send("This request was already declined.");
    }

    const { startsAt, endsAt } = computeCleaningWindowPR(reservation.checkOut);

    const lock = reservation.property?.locks?.find(
      (l: any) => l.isActive && l.ttlockLockId
    );

    const ttlockLockId = lock?.ttlockLockId ? Number(lock.ttlockLockId) : null;

    if (!ttlockLockId) {
      return res.status(400).send("No active TTLock lock configured for this property.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.cleaningConfirmation.update({
        where: { id: confirmation.id },
        data: {
          status: "CONFIRMED",
        },
      });

      await tx.staffAssignment.upsert({
        where: {
          reservationId_staffMemberId: {
            reservationId: confirmation.reservationId,
            staffMemberId: confirmation.staffMemberId,
          },
        },
        create: {
          reservationId: confirmation.reservationId,
          staffMemberId: confirmation.staffMemberId,
          method: StaffAccessMethod.NFC_TIMEBOUND,
          startsAt,
          endsAt,
          status: StaffAssignmentStatus.SCHEDULED,
        },
        update: {
          method: StaffAccessMethod.NFC_TIMEBOUND,
          startsAt,
          endsAt,
          status: StaffAssignmentStatus.SCHEDULED,
          lastError: null,
        },
      });

      const existingCleaningNfc = await tx.nfcAssignment.findFirst({
        where: {
          reservationId: confirmation.reservationId,
          role: NfcAssignmentRole.CLEANING,
        },
      });

      if (!existingCleaningNfc) {
        await assignNfcCards(tx as any, {
          reservationId: confirmation.reservationId,
          ttlockLockId,
          propertyId: confirmation.propertyId,
          role: NfcAssignmentRole.CLEANING,
          startsAt,
          endsAt,
          count: 1,
        });
      }
    });

    return res.send(
      "Cleaning confirmed. Pin&Go will activate your NFC access during the cleaning window."
    );
  } catch (e: any) {
    console.error("[CLEANING_CONFIRM_CONFIRM_ERROR]", e);
    return res.status(500).send(e?.message ?? "Failed to confirm cleaning.");
  }
});

// POST /cleaning/confirm/:token/decline
cleaningConfirmRouter.post("/cleaning/confirm/:token/decline", async (req, res) => {
  try {
    const token = String(req.params.token ?? "");

    const confirmation = await prisma.cleaningConfirmation.findUnique({
      where: { token },
    });

    if (!confirmation) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    if (confirmation.status === "CONFIRMED") {
      return res.status(409).send("This request was already confirmed.");
    }

    await prisma.cleaningConfirmation.update({
      where: { id: confirmation.id },
      data: {
        status: "DECLINED",
      },
    });

    return res.send("Cleaning declined. Pin&Go will try the next available backup cleaner.");
  } catch (e: any) {
    return res.status(500).send(e?.message ?? "Failed to decline cleaning.");
  }
});