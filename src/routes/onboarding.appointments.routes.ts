import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { fromZonedTime } from "date-fns-tz";

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

        const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

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
            `Remote assistance requested: ${
              remoteAssistanceRequested ? "Yes" : "No"
            }`,
            "",
            "Pin&Go onboarding session.",
            "If remote assistance is needed, we may guide the client through screen sharing or a secure remote support tool such as AnyDesk, TeamViewer, or Chrome Remote Desktop.",
          ].join("\n"),
          start: {
            dateTime: startDate.toISOString(),
            timeZone: appointmentTimezone,
          },
          end: {
            dateTime: endDate.toISOString(),
            timeZone: appointmentTimezone,
          },
          attendees: [{ email }],
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

        console.log("[ONBOARDING_GOOGLE_EVENT_CREATED]", {
          googleEventId,
          googleMeetLink,
          conferenceStatus:
            calendarRes.data.conferenceData?.createRequest?.status?.statusCode,
        });

        calendarStatus = "created";
      } catch (calendarError: any) {
        console.error("[GOOGLE_CALENDAR_ERROR]", {
          message: calendarError?.message,
          code: calendarError?.code,
          errors: calendarError?.errors,
        });

        calendarStatus = "failed";
      }
    } else {
      console.warn("[ONBOARDING] Google Calendar not configured → skipping");
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