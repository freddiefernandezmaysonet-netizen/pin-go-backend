import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";
import { requireOrg } from "../middleware/requireOrg";

const prisma = new PrismaClient();
const router = Router();

function toErrString(e: unknown) {
  const anyError = e as any;

  if (e instanceof Error) {
    const code = anyError?.code ? ` code=${anyError.code}` : "";
    const status = anyError?.status ? ` status=${anyError.status}` : "";

    return `${e.name}: ${e.message}${code}${status}`;
  }

  return String(e);
}

function isNonRetryableSmsError(value: unknown) {
  const error = String(value ?? "").toLowerCase();

  return (
    error.includes("not a valid phone number") ||
    error.includes("invalid phone number") ||
    error.includes("invalid 'to' phone number") ||
    error.includes("unable to create record") ||
    error.includes("the 'to' number") ||
    error.includes("is not a valid") ||
    error.includes("not sms capable") ||
    error.includes("not a mobile number") ||
    error.includes("landline") ||
    error.includes("unsubscribed") ||
    error.includes("blacklisted") ||
    error.includes("recipient is unable to receive") ||
    error.includes("destination phone number") ||
    error.includes("twilio error 21211") ||
    error.includes("twilio error 21614") ||
    error.includes("21211") ||
    error.includes("21614")
  );
}

// =======================
// GET messages
// =======================
router.get("/messages", requireOrg(prisma), async (req, res) => {
  try {
    const orgId = String((req as any).orgId ?? "").trim();
    const rawStatus = String(req.query.status ?? "").trim();
    const rawPropertyId = String(req.query.propertyId ?? "").trim();

    const status = rawStatus ? rawStatus.toUpperCase() : "";
    const propertyId = rawPropertyId || "";

    const items = await prisma.messageLog.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [
          {
            organizationId: orgId,
            ...(propertyId ? { propertyId } : {}),
          },
          {
            organizationId: null,
            ...(propertyId ? { propertyId: null } : {}),
            accessGrant: {
              reservation: {
                property: {
                  organizationId: orgId,
                  ...(propertyId ? { id: propertyId } : {}),
                },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        accessGrant: {
          select: {
            id: true,
            reservation: {
              select: {
                id: true,
                propertyId: true,
                property: {
                  select: {
                    id: true,
                    name: true,
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const propertyIds = Array.from(
      new Set(
        items
          .map((item) => item.propertyId ?? item.accessGrant?.reservation?.propertyId ?? null)
          .filter((v): v is string => Boolean(v))
      )
    );

    const properties =
      propertyIds.length > 0
        ? await prisma.property.findMany({
            where: {
              id: { in: propertyIds },
              organizationId: orgId,
            },
            select: {
              id: true,
              name: true,
            },
          })
        : [];

    const propertyNameById = new Map(properties.map((p) => [p.id, p.name]));

    res.json({
      items: items.map((item) => {
        const resolvedPropertyId =
          item.propertyId ?? item.accessGrant?.reservation?.propertyId ?? null;

        const resolvedPropertyName =
          (resolvedPropertyId ? propertyNameById.get(resolvedPropertyId) : null) ??
          item.accessGrant?.reservation?.property?.name ??
          null;

        return {
          id: item.id,
          channel: item.channel,
          provider: item.provider,
          to: item.to,
          body: item.body,
          status: item.status,
          error: item.error ?? null,
          retryCount: item.retryCount,
          createdAt: item.createdAt,
          reservationId: item.reservationId ?? item.accessGrant?.reservation?.id ?? null,
          propertyId: resolvedPropertyId,
          propertyName: resolvedPropertyName,
          organizationId:
            item.organizationId ??
            item.accessGrant?.reservation?.property?.organizationId ??
            null,
        };
      }),
    });
  } catch (e) {
    console.error("[messages] fetch error", e);
    res.status(500).json({ ok: false });
  }
});

// =======================
// POST retry
// =======================
router.post("/messages/:id/retry", requireOrg(prisma), async (req, res) => {
  try {
    const orgId = String((req as any).orgId ?? "").trim();
    const { id } = req.params;

    const msg = await prisma.messageLog.findFirst({
      where: {
        id,
        OR: [
          { organizationId: orgId },
          {
            organizationId: null,
            accessGrant: {
              reservation: {
                property: {
                  organizationId: orgId,
                },
              },
            },
          },
        ],
      },
      include: {
        accessGrant: {
          select: {
            reservation: {
              select: {
                property: {
                  select: {
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!msg) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const channel = String(msg.channel ?? "").trim().toLowerCase();
    const status = String(msg.status ?? "").trim().toUpperCase();

    if (channel !== "sms") {
      return res.status(400).json({
        ok: false,
        error: "unsupported_retry_channel",
        message: "This retry endpoint only supports SMS messages.",
      });
    }

    if (status === "FAILED_FINAL") {
      return res.status(409).json({
        ok: false,
        error: "non_retryable_message",
        message: "This SMS has a non-retryable delivery failure.",
      });
    }

    if (status !== "FAILED") {
      return res.status(400).json({
        ok: false,
        error: "invalid_retry_status",
        message: "Only FAILED SMS messages can be retried.",
      });
    }

    if (!msg.to || !msg.body) {
      return res.status(400).json({ ok: false, error: "invalid_message" });
    }

    if (isNonRetryableSmsError(msg.error)) {
      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "FAILED_FINAL",
          error: msg.error ?? "Non-retryable SMS delivery error",
        },
      });

      return res.status(409).json({
        ok: false,
        error: "non_retryable_sms_error",
        message: "This SMS error is permanent and will not be retried.",
      });
    }

    try {
      const sent = await sendSms(msg.to, msg.body);

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: (sent as any)?.sid ?? null,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      return res.json({ ok: true });
    } catch (e: any) {
      const error = toErrString(e);
      const nonRetryable = isNonRetryableSmsError(error);

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: nonRetryable ? "FAILED_FINAL" : "FAILED",
          retryCount: { increment: 1 },
          error,
        },
      });

      return res.status(nonRetryable ? 409 : 500).json({
        ok: false,
        error: nonRetryable ? "non_retryable_sms_error" : "retry_failed",
      });
    }
  } catch (e) {
    console.error("[messages retry] error", e);
    res.status(500).json({ ok: false });
  }
});

export default router;