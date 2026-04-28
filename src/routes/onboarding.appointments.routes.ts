import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";

const prisma = new PrismaClient();
export const onboardingAppointmentsRouter = Router();

/**
 * POST /api/onboarding/appointments
 */
onboardingAppointmentsRouter.post("/", async (req, res) => {
  try {
    const { name, email, phone, topic, scheduledAt } = req.body;

    if (!name || !email || !scheduledAt) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (name, email, scheduledAt)",
      });
    }

    const startDate = new Date(scheduledAt);

    let googleEventId: string | null = null;
    let calendarStatus: "created" | "skipped" = "skipped";

    // =========================
    // CHECK GOOGLE CONFIG
    // =========================
    const hasGoogleConfig =
      process.env.GOOGLE_CALENDAR_CLIENT_ID &&
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN &&
      process.env.GOOGLE_CALENDAR_ID;

    // =========================
    // CREATE GOOGLE EVENT (IF CONFIGURED)
    // =========================
    if (hasGoogleConfig) {
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CALENDAR_CLIENT_ID,
          process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
          process.env.GOOGLE_CALENDAR_REDIRECT_URI
        );

        oauth2Client.setCredentials({
          refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
        });

        const calendar = google.calendar({
          version: "v3",
          auth: oauth2Client,
        });

        const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

        const event = {
          summary: `Onboarding Pin&Go - ${name}`,
          description: `Cliente: ${name}\nEmail: ${email}\nTel: ${phone ?? "-"}\nTema: ${topic ?? "-"}`,
          start: {
            dateTime: startDate.toISOString(),
            timeZone: "UTC",
          },
          end: {
            dateTime: endDate.toISOString(),
            timeZone: "UTC",
          },
          attendees: [{ email }],
        };

        const calendarRes = await calendar.events.insert({
          calendarId: process.env.GOOGLE_CALENDAR_ID,
          requestBody: event,
        });

        googleEventId = calendarRes.data.id ?? null;
        calendarStatus = "created";
      } catch (calendarError) {
        console.error("[GOOGLE_CALENDAR_ERROR]", calendarError);
      }
    } else {
      console.warn("[ONBOARDING] Google Calendar not configured → skipping");
    }

    // =========================
    // SAVE IN DB (SIEMPRE)
    // =========================
    const appointment = await prisma.onboardingAppointment.create({
      data: {
        name,
        email,
        phone,
        topic,
        scheduledAt: startDate,
        googleEventId,
      },
    });

    return res.json({
      ok: true,
      appointmentId: appointment.id,
      calendar: calendarStatus,
    });
  } catch (error: any) {
    console.error("[ONBOARDING_APPOINTMENT_ERROR]", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to create onboarding appointment",
    });
  }
});