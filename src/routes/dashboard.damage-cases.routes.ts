import { Router, type Request, type Response } from "express";
import { DamageCaseStatus, Prisma, PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { evaluateDamageCasePolicy } from "../services/damage-case-policy.service.js";
import { notifyGuestOfApprovedDamageCase } from "../services/damage-case-guest-notification.service.js";
import { notifyGuestOfNoChargeDamageCaseClosure } from "../services/damage-case-guest-closure-notification.service.js";
import { syncDamageCaseMissionControlSafely } from "../services/damage-case-mission-control.service.js";

type AuthUser = { id: string; orgId: string };

function user(req: Request): AuthUser {
  return (req as any).user as AuthUser;
}

function evidencePresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

async function notifyGuestOfClosureSafely(input: {
  prisma: PrismaClient;
  damageCaseId: string;
}) {
  try {
    return await notifyGuestOfNoChargeDamageCaseClosure(input);
  } catch (error) {
    return {
      ok: false,
      code: "DAMAGE_CASE_GUEST_CLOSURE_NOTICE_UNEXPECTED_ERROR" as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildDashboardDamageCasesRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/api/dashboard/damage-cases/:id", requireAuth, async (req, res) => {
    const auth = user(req);
    const item = await prisma.damageCase.findFirst({
      where: {
        id: String(req.params.id),
        reservation: { property: { organizationId: auth.orgId } },
      },
      include: {
        reservation: {
          select: {
            id: true,
            reservationNumber: true,
            propertyId: true,
            guestName: true,
            checkIn: true,
            checkOut: true,
            maxDamageLiabilityAmountSnapshot: true,
            damagePaymentMethodStatus: true,
          },
        },
      },
    });
    if (!item) return res.status(404).json({ ok: false, error: "DAMAGE_CASE_NOT_FOUND" });
    return res.json({ ok: true, damageCase: item });
  });

  router.post("/api/dashboard/reservations/:reservationId/damage-case", requireAuth, async (req, res) => {
    const auth = user(req);
    const reservation = await prisma.reservation.findFirst({
      where: {
        id: String(req.params.reservationId),
        property: { organizationId: auth.orgId },
      },
      select: {
        id: true,
        currency: true,
        propertyProtectionRequiredSnapshot: true,
        maxDamageLiabilityAmountSnapshot: true,
        damagePaymentMethodStatus: true,
        stripeDamageCustomerId: true,
        stripeDamagePaymentMethodId: true,
        damageCase: { select: { id: true } },
      },
    });

    if (!reservation) {
      return res.status(404).json({ ok: false, error: "RESERVATION_NOT_FOUND" });
    }
    if (reservation.damageCase) {
      return res.status(409).json({
        ok: false,
        error: "DAMAGE_CASE_ALREADY_EXISTS",
        damageCaseId: reservation.damageCase.id,
      });
    }

    const description = String(req.body?.description ?? "").trim();
    if (!description) {
      return res.status(400).json({ ok: false, error: "DAMAGE_DESCRIPTION_REQUIRED" });
    }

    const policy = evaluateDamageCasePolicy({
      reservation,
      requestedAmount: req.body?.requestedAmount,
    });
    if (!policy.ok) {
      return res.status(409).json({ ok: false, error: policy.code });
    }

    const evidence = req.body?.evidence ?? null;
    const created = await prisma.damageCase.create({
      data: {
        reservationId: reservation.id,
        requestedAmount: policy.requestedAmount,
        currency: String(reservation.currency ?? "usd").toLowerCase(),
        description,
        evidence:
          evidence === null
            ? Prisma.DbNull
            : (evidence as Prisma.InputJsonValue),
        reportedByUserId: auth.id,
        status: evidencePresent(evidence)
          ? DamageCaseStatus.OPEN
          : DamageCaseStatus.EVIDENCE_PENDING,
      },
    });

    await syncDamageCaseMissionControlSafely({
      prisma,
      damageCaseId: created.id,
    });

    return res.status(201).json({ ok: true, damageCase: created });
  });

  router.patch("/api/dashboard/damage-cases/:id", requireAuth, async (req, res) => {
    const auth = user(req);
    const existing = await prisma.damageCase.findFirst({
      where: {
        id: String(req.params.id),
        reservation: { property: { organizationId: auth.orgId } },
      },
      include: {
        reservation: {
          select: {
            propertyProtectionRequiredSnapshot: true,
            maxDamageLiabilityAmountSnapshot: true,
            damagePaymentMethodStatus: true,
            stripeDamageCustomerId: true,
            stripeDamagePaymentMethodId: true,
          },
        },
      },
    });
    if (!existing) return res.status(404).json({ ok: false, error: "DAMAGE_CASE_NOT_FOUND" });
    if (![DamageCaseStatus.OPEN, DamageCaseStatus.EVIDENCE_PENDING].includes(existing.status)) {
      return res.status(409).json({ ok: false, error: "DAMAGE_CASE_NOT_EDITABLE" });
    }

    const requestedAmount =
      req.body?.requestedAmount === undefined
        ? Number(existing.requestedAmount)
        : req.body.requestedAmount;
    const policy = evaluateDamageCasePolicy({
      reservation: existing.reservation,
      requestedAmount,
    });
    if (!policy.ok) return res.status(409).json({ ok: false, error: policy.code });

    const description =
      req.body?.description === undefined
        ? existing.description
        : String(req.body.description ?? "").trim();
    if (!description) {
      return res.status(400).json({ ok: false, error: "DAMAGE_DESCRIPTION_REQUIRED" });
    }
    const evidence =
      req.body?.evidence === undefined ? existing.evidence : req.body.evidence;

    const updated = await prisma.damageCase.update({
      where: { id: existing.id },
      data: {
        requestedAmount: policy.requestedAmount,
        description,
        evidence:
          evidence === null
            ? Prisma.DbNull
            : (evidence as Prisma.InputJsonValue),
        status: evidencePresent(evidence)
          ? DamageCaseStatus.OPEN
          : DamageCaseStatus.EVIDENCE_PENDING,
      },
    });
    await syncDamageCaseMissionControlSafely({
      prisma,
      damageCaseId: updated.id,
    });
    return res.json({ ok: true, damageCase: updated });
  });

  router.post("/api/dashboard/damage-cases/:id/submit-review", requireAuth, async (req, res) => {
    const auth = user(req);
    const existing = await prisma.damageCase.findFirst({
      where: {
        id: String(req.params.id),
        reservation: { property: { organizationId: auth.orgId } },
      },
    });
    if (!existing) return res.status(404).json({ ok: false, error: "DAMAGE_CASE_NOT_FOUND" });
    if (![DamageCaseStatus.OPEN, DamageCaseStatus.EVIDENCE_PENDING].includes(existing.status)) {
      return res.status(409).json({ ok: false, error: "DAMAGE_CASE_REVIEW_TRANSITION_INVALID" });
    }
    if (!evidencePresent(existing.evidence)) {
      return res.status(409).json({ ok: false, error: "DAMAGE_EVIDENCE_REQUIRED" });
    }

    const updated = await prisma.damageCase.update({
      where: { id: existing.id },
      data: { status: DamageCaseStatus.HOST_REVIEW },
    });
    await syncDamageCaseMissionControlSafely({
      prisma,
      damageCaseId: updated.id,
    });
    return res.json({ ok: true, damageCase: updated });
  });

  router.post("/api/dashboard/damage-cases/:id/approve", requireAuth, async (req, res) => {
    const auth = user(req);
    const existing = await prisma.damageCase.findFirst({
      where: {
        id: String(req.params.id),
        reservation: { property: { organizationId: auth.orgId } },
      },
      include: {
        reservation: {
          select: {
            propertyProtectionRequiredSnapshot: true,
            maxDamageLiabilityAmountSnapshot: true,
            damagePaymentMethodStatus: true,
            stripeDamageCustomerId: true,
            stripeDamagePaymentMethodId: true,
          },
        },
      },
    });
    if (!existing) return res.status(404).json({ ok: false, error: "DAMAGE_CASE_NOT_FOUND" });
    if (existing.status !== DamageCaseStatus.HOST_REVIEW) {
      return res.status(409).json({ ok: false, error: "DAMAGE_CASE_APPROVAL_TRANSITION_INVALID" });
    }

    const policy = evaluateDamageCasePolicy({
      reservation: existing.reservation,
      requestedAmount: Number(existing.requestedAmount),
      approvedAmount: req.body?.approvedAmount,
    });
    if (!policy.ok) return res.status(409).json({ ok: false, error: policy.code });

    const updated = await prisma.damageCase.update({
      where: { id: existing.id },
      data: {
        approvedAmount: policy.approvedAmount,
        hostApprovedAt: new Date(),
        hostApprovedByUserId: auth.id,
        status: DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
      },
    });

    const guestNotification = await notifyGuestOfApprovedDamageCase({
      prisma,
      damageCaseId: updated.id,
    });

    const finalDamageCase = guestNotification.ok
      ? await prisma.damageCase.findUnique({ where: { id: updated.id } })
      : updated;

    return res.json({
      ok: true,
      damageCase: finalDamageCase ?? updated,
      guestNotification,
    });
  });

  router.post("/api/dashboard/damage-cases/:id/close-no-charge", requireAuth, async (req, res) => {
    const auth = user(req);
    const existing = await prisma.damageCase.findFirst({
      where: {
        id: String(req.params.id),
        reservation: { property: { organizationId: auth.orgId } },
      },
    });
    if (!existing) return res.status(404).json({ ok: false, error: "DAMAGE_CASE_NOT_FOUND" });
    if (existing.status === DamageCaseStatus.CLOSED_NO_CHARGE) {
      await syncDamageCaseMissionControlSafely({
        prisma,
        damageCaseId: existing.id,
      });
      const guestClosureNotification = await notifyGuestOfClosureSafely({
        prisma,
        damageCaseId: existing.id,
      });
      return res.json({
        ok: true,
        damageCase: existing,
        alreadyClosed: true,
        guestClosureNotification,
      });
    }
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) return res.status(400).json({ ok: false, error: "DAMAGE_CASE_CLOSE_REASON_REQUIRED" });

    const updated = await prisma.damageCase.update({
      where: { id: existing.id },
      data: {
        status: DamageCaseStatus.CLOSED_NO_CHARGE,
        closedAt: new Date(),
        closedReason: reason,
      },
    });
    await syncDamageCaseMissionControlSafely({
      prisma,
      damageCaseId: updated.id,
    });
    const guestClosureNotification = await notifyGuestOfClosureSafely({
      prisma,
      damageCaseId: updated.id,
    });
    return res.json({
      ok: true,
      damageCase: updated,
      guestClosureNotification,
    });
  });

  return router;
}
