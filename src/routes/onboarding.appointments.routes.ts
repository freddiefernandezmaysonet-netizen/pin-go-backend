import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const prisma = new PrismaClient();
export const onboardingAppointmentsRouter = Router();

function extractMeetLink(eventData: any): string | null {
  return (
    eventData?.hangoutLink ??
    eventData?.conferenceData?.entryPoints?.find(
      (p: any) => p.entryPointType === "video"
    )?.uri ??
    null
  );
}

onboardingAppointmentsRouter.get("/availability", async (req, res) => {
  try {
    const { date, timezone } = req.query;

    if (!date || typeof date !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing date (YYYY-MM-DD)",
      });
    }

    const appointmentTimezone =
      typeof timezone === "string" && timezone.trim()
        ? timezone.trim()
        : "UTC";

    // 🔹 generar horas de 9am a 5pm
    const slots: { time: string; available: boolean }[] = [];

    for (let hour = 9; hour < 18; hour++) {
      const localDateTime = `${date}T${String(hour).padStart(2, "0")}:00`;

      const startDate = fromZonedTime(localDateTime, appointmentTimezone);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

      // 🔴 validar fin de semana
      const dayOfWeek = formatInTimeZone(
        startDate,
        appointmentTimezone,
        "EEEE"
      );

      if (dayOfWeek === "Saturday" || dayOfWeek === "Sunday") {
        slots.push({
          time: `${String(hour).padStart(2, "0")}:00`,
          available: false,
        });
        continue;
      }

      // 🔴 verificar si ya está ocupado
      const existing = await prisma.onboardingAppointment.findFirst({
        where: {
          scheduledAt: {
            gte: startDate,
            lt: endDate,
          },
          status: {
            not: "CANCELLED",
          },
        },
      });

      slots.push({
        time: `${String(hour).padStart(2, "0")}:00`,
        available: !existing,
      });
    }

    return res.json({
      ok: true,
      slots,
    });
  } catch (error) {
    console.error("[AVAILABILITY_ERROR]", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to get availability",
    });
  }
});

onboardingAppointmentsRouter.post("/", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      topic,
      scheduledAt,
      timezone,
      remoteAssistanceRequested,
    } = req.body;

    if (!name || !email || !scheduledAt) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields (name, email, scheduledAt)",
      });
    }

    const appointmentTimezone =
      typeof timezone === "string" && timezone.trim()
        ? timezone.trim()
        : "UTC";

    const startDate = fromZonedTime(scheduledAt, appointmentTimezone);

    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "Invalid scheduledAt date",
      });
    }

    // 🔴 1. Bloquear fines de semana
    const dayOfWeek = formatInTimeZone(
      startDate,
      appointmentTimezone,
      "EEEE"
    );

    if (dayOfWeek === "Saturday" || dayOfWeek === "Sunday") {
      return res.status(400).json({
        ok: false,
        error: "Weekend appointments are not available",
      });
    }

    // 🔴 2. Bloquear horario (9am - 6pm)
    const hour = Number(
      formatInTimeZone(startDate, appointmentTimezone, "H")
    );

    if (hour < 9 || hour >= 18) {
      return res.status(400).json({
        ok: false,
        error: "Appointments are only available from 9:00 AM to 6:00 PM",
      });
    }

    // 🔴 3. Duración 1 hora
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    // 🔴 4. Evitar doble booking
    const existing = await prisma.onboardingAppointment.findFirst({
      where: {
        scheduledAt: {
          gte: startDate,
          lt: endDate,
        },
        status: {
          not: "CANCELLED",
        },
      },
    });

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "This time slot is already booked",
      });
    }

    let googleEventId: string | null = null;
    let googleMeetLink: string | null = null;
    let calendarStatus: "created" | "skipped" | "failed" = "skipped";

    const hasGoogleConfig =
      process.env.GOOGLE_CALENDAR_CLIENT_ID &&
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN &&
      process.env.GOOGLE_CALENDAR_ID;

    if (hasGoogleConfig) {
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim(),
          process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim(),
          process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim()
        );

        oauth2Client.setCredentials({
          refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim(),
        });

        const calendar = google.calendar({
          version: "v3",
          auth: oauth2Client,
        });

        const requestId = `pingo-onboarding-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;

        const event = {
          summary: `Pin&Go Onboarding - ${name}`,
          description: [
            `Client: ${name}`,
            `Email: ${email}`,
            `Phone: ${phone ?? "-"}`,
            `Topic: ${topic ?? "-"}`,
            `Timezone: ${appointmentTimezone}`,
            `Remote assistance requested: ${
              remoteAssistanceRequested ? "Yes" : "No"
            }`,
            "",
            "Pin&Go onboarding session.",
          ].join("\n"),
          start: {
            dateTime: startDate.toISOString(),
            timeZone: appointmentTimezone,
          },
          end: {
            dateTime: endDate.toISOString(),
            timeZone: appointmentTimezone,
          },
          attendees: [{ email }, { email: "support@pin-ngo.com" }],
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: {
                type: "hangoutsMeet",
              },
            },
          },
        };

        const calendarRes = await calendar.events.insert({
          calendarId: process.env.GOOGLE_CALENDAR_ID,
          requestBody: event,
          conferenceDataVersion: 1,
          sendUpdates: "all",
        });

        googleEventId = calendarRes.data.id ?? null;
        googleMeetLink = extractMeetLink(calendarRes.data);

        if (googleEventId && !googleMeetLink) {
          const eventRead = await calendar.events.get({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            eventId: googleEventId,
            conferenceDataVersion: 1,
          });

          googleMeetLink = extractMeetLink(eventRead.data);
        }

        calendarStatus = "created";
      } catch (err: any) {
        console.error("[GOOGLE_CALENDAR_ERROR]", err);
        calendarStatus = "failed";
      }
    }

    const appointment = await prisma.onboardingAppointment.create({
      data: {
        name,
        email,
        phone,
        topic,
        scheduledAt: startDate,
        googleEventId,
        googleMeetLink,
        remoteAssistanceRequested: Boolean(remoteAssistanceRequested),
      },
    });

    return res.json({
      ok: true,
      appointmentId: appointment.id,
      calendar: calendarStatus,
      googleEventId,
      googleMeetLink,
    });
  } catch (error: any) {
    console.error("[ONBOARDING_APPOINTMENT_ERROR]", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to create onboarding appointment",
    });
  }
});