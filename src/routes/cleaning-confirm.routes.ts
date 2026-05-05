import { Router } from "express";
import { PrismaClient, StaffAccessMethod, StaffAssignmentStatus } from "@prisma/client";
import { computeCleaningWindowPR } from "../services/cleaningWindow.service";

const prisma = new PrismaClient();

export const cleaningConfirmRouter = Router();

// GET /cleaning/confirm/:token
cleaningConfirmRouter.get("/cleaning/confirm/:token", async (req, res) => {
  try {
    const token = String(req.params.token ?? "");

    const confirmation = await prisma.cleaningConfirmation.findUnique({
      where: { token },
      include: {
        reservation: {
          include: {
            property: true,
          },
        },
        staffMember: true,
      },
    });

    if (!confirmation) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    if (confirmation.status === "CONFIRMED") {
      return res.send("Cleaning already confirmed. Thank you.");
    }

    if (confirmation.status === "DECLINED") {
      return res.send("This cleaning request was already declined.");
    }

    const propertyName = confirmation.reservation?.property?.name ?? "Property";
    const staffName = confirmation.staffMember?.fullName ?? "Cleaner";

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

    const confirmation = await prisma.cleaningConfirmation.findUnique({
      where: { token },
      include: {
        reservation: {
          include: {
            property: true,
          },
        },
        staffMember: true,
      },
    });

    if (!confirmation) {
      return res.status(404).send("Invalid or expired cleaning confirmation link.");
    }

    if (confirmation.status === "CONFIRMED") {
      return res.send("Cleaning already confirmed. Thank you.");
    }

    if (confirmation.status === "DECLINED") {
      return res.status(409).send("This request was already declined.");
    }

    const { startsAt, endsAt } = computeCleaningWindowPR(
      confirmation.reservation.checkOut
    );

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
    });

    return res.send("Cleaning confirmed. Pin&Go will activate your NFC access during the cleaning window.");
  } catch (e: any) {
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