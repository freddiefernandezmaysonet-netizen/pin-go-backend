import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { processWebhookEventById } from "../pms/ingest/webhook.processor";
import { completeInternalDemoSecurePrecheckin } from "../services/internal-demo-secure-precheckin.service";
import { dispatchPendingCleaningConfirmationForReservation } from "../services/cleaning-confirmation-dispatch.service";

const prisma = new PrismaClient();
export const adminDemoRouter = Router();

function assertPlatformAdmin(req: any, res: any) {
  const user = req.user;

  if (!user || user.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "Forbidden",
    });
    return false;
  }

  return true;
}

adminDemoRouter.post(
  "/api/internal/admin/demo/run",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const user = (req as any).user;
      const orgId = user.orgId as string;

      const {
        checkIn,
        checkOut,
        guestName,
        guestEmail,
        guestPhone,
        preferredLanguage,
        smsConsent,
      } = req.body ?? {};

      const cleanGuestName = String(
        guestName ?? ""
      ).trim();
      const cleanGuestEmail = String(
        guestEmail ?? ""
      )
        .trim()
        .toLowerCase();
      const cleanGuestPhone = String(
        guestPhone ?? ""
      ).trim();
      const cleanPreferredLanguage =
        preferredLanguage === "es"
          ? "es"
          : preferredLanguage === "en"
          ? "en"
          : null;
      const hasSmsConsent =
        smsConsent === true;

      if (!checkIn || !checkOut) {
        return res.status(400).json({
          ok: false,
          error: "Missing checkIn/checkOut",
        });
      }

      if (
        !cleanGuestName ||
        cleanGuestName.length > 120
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Guest name is required and must not exceed 120 characters",
        });
      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          cleanGuestEmail
        ) ||
        cleanGuestEmail.length > 254
      ) {
        return res.status(400).json({
          ok: false,
          error: "A valid guest email is required",
        });
      }

      if (
        cleanGuestPhone &&
        !/^\+[1-9]\d{7,14}$/.test(
          cleanGuestPhone
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Guest phone must use E.164 format, for example +17875550123",
        });
      }

      if (
        hasSmsConsent &&
        !cleanGuestPhone
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Guest phone is required when SMS consent is enabled",
        });
      }

      if (!cleanPreferredLanguage) {
        return res.status(400).json({
          ok: false,
          error:
            "Preferred language must be es or en",
        });
      }

      const checkInDate = new Date(checkIn);
      const checkOutDate = new Date(checkOut);

      if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
        return res.status(400).json({
          ok: false,
          error: "Invalid checkIn/checkOut",
        });
      }

      if (checkOutDate <= checkInDate) {
        return res.status(400).json({
          ok: false,
          error: "checkOut must be after checkIn",
        });
      }

      const connection = await prisma.pmsConnection.findFirst({
        where: {
          organizationId: orgId,
          provider: PmsProvider.LODGIFY,
          status: "ACTIVE",
        },
      });

      if (!connection) {
        return res.status(400).json({
          ok: false,
          error: "No active Lodgify connection found",
        });
      }

      const externalId = `DEMO-${Date.now()}`;

      const demoCreatedAt =
        new Date().toISOString();
      const payload = {
        event: "booking_change",
        booking_id: externalId,
        id: externalId,

        property_id: "DEMO",
        property_name: "Demo",

        arrival: checkInDate.toISOString(),
        departure: checkOutDate.toISOString(),

        guest_name: cleanGuestName,
        guest_email: cleanGuestEmail,
        guest_phone:
          cleanGuestPhone || null,

        status: "Booked",

        amount_paid: 100,
        total_amount: 100,
        amount_due: 0,

        updated_at: demoCreatedAt,
        created_at: demoCreatedAt,

        consent: {
          stayNotificationsConsent:
            hasSmsConsent,
          smsConsent: hasSmsConsent,
          consentSource:
            "INTERNAL_DEMO_CENTER",
          consentVersion:
            "stay_notifications_v1",
          acceptedAt: hasSmsConsent
            ? demoCreatedAt
            : null,
        },

        demo: true,
        created_by: user.email ?? user.id,
      };

      const event = await prisma.webhookEventIngest.create({
        data: {
          connectionId: connection.id,
          provider: PmsProvider.LODGIFY,
          eventType: "DEMO_BOOKING",
          externalEventId: externalId,
          payloadRaw: payload,
          status: "PENDING",
        },
      });

      await processWebhookEventById(event.id);

      const processedEvent = await prisma.webhookEventIngest.findUnique({
        where: { id: event.id },
      });

      const reservation = await prisma.reservation.findFirst({
        where: {
          externalProvider: "LODGIFY",
          externalId,
        },
        include: {
          accessGrants: {
            include: {
              lock: true,
            },
          },
          NfcAssignment: true,
        },
      });

      let securePrecheckin = null;
      let cleaningConfirmationDispatch: any = null;

      if (
        reservation &&
        processedEvent?.status === "PROCESSED"
      ) {
        try {
          securePrecheckin =
            await completeInternalDemoSecurePrecheckin(
              prisma,
              {
                reservationId: reservation.id,
                actor: {
                  userId: user.id,
                  organizationId: user.orgId,
                  email: user.email ?? null,
                  role: user.role,
                },
                delivery: {
                  preferredLanguage:
                    cleanPreferredLanguage,
                  smsConsent:
                    hasSmsConsent,
                },
              }
            );
        } catch (error: any) {
          const message = String(
            error?.message ?? error
          );

          await prisma.webhookEventIngest.update({
            where: {
              id: event.id,
            },
            data: {
              status: "FAILED",
              lastError:
                `DEMO_SECURE_PRECHECKIN_FAILED:${message}`,
            },
          });

          return res.status(409).json({
            ok: false,
            error:
              `Demo secure pre-check-in failed: ${message}`,
          });
        }

        try {
          cleaningConfirmationDispatch =
            await dispatchPendingCleaningConfirmationForReservation({
              prisma,
              reservationId: reservation.id,
            });

          console.log(
            "[DEMO_CLEANING_CONFIRMATION_DISPATCH_RESULT]",
            {
              reservationId: reservation.id,
              sent:
                cleaningConfirmationDispatch?.sent ?? false,
              skipped:
                cleaningConfirmationDispatch?.skipped ?? false,
              reason:
                cleaningConfirmationDispatch?.reason ?? null,
              confirmationId:
                cleaningConfirmationDispatch?.confirmationId ?? null,
            }
          );
        } catch (error: any) {
          const message = String(
            error?.message ?? error
          );

          console.error(
            "[DEMO_CLEANING_CONFIRMATION_DISPATCH_ERROR]",
            {
              reservationId: reservation.id,
              error: message,
            }
          );

          cleaningConfirmationDispatch = {
            sent: false,
            skipped: false,
            reason: "DISPATCH_FAILED",
            error: message,
          };
        }
      }

      return res.json({
        ok: true,
        data: {
          eventId: event.id,
          eventStatus: processedEvent?.status ?? null,
          eventError: processedEvent?.lastError ?? null,
          reservation,
          checkIn: checkInDate.toISOString(),
          checkOut: checkOutDate.toISOString(),
          paymentState: "PAID",
          delivery: {
            email: {
              enabled: true,
              to: cleanGuestEmail,
            },
            sms: {
              enabled: hasSmsConsent,
              to: hasSmsConsent
                ? cleanGuestPhone
                : null,
            },
            preferredLanguage:
              cleanPreferredLanguage,
          },
          securePrecheckin,
          cleaningConfirmationDispatch,
          message: "Demo pipeline executed",
        },
      });
    } catch (error) {
      console.error("[DEMO_PIPELINE_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: "Demo pipeline failed",
      });
    }
  }
);

adminDemoRouter.post(
  "/api/internal/webhook-events/:id/reprocess",
  async (req, res) => {
    try {
      const { id } = req.params;

      const existing = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "WEBHOOK_EVENT_NOT_FOUND",
        });
      }

      await prisma.webhookEventIngest.update({
        where: { id },
        data: {
          status: "PENDING",
          lastError: null,
          processedAt: null,
        },
      });

      await processWebhookEventById(id);

      const processed = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      return res.json({
        ok: true,
        eventId: id,
        status: processed?.status ?? null,
        lastError: processed?.lastError ?? null,
        processedAt: processed?.processedAt ?? null,
      });
    } catch (error: any) {
      console.error("[WEBHOOK_REPROCESS_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "WEBHOOK_REPROCESS_FAILED",
      });
    }
  }
);
