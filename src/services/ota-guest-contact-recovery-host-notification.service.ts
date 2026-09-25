import { DashboardUserRole, PrismaClient } from "@prisma/client";
import { sendGuestContactRecoveryHostNotice } from "../lib/mailer";
import { sendLoggedEmail } from "./email-delivery.service";

const TYPE = "CHANNEX_GUEST_CONTACT_RECOVERY_REQUIRED" as const;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function appUrl() {
  return clean(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export async function notifyHostGuestContactRecoveryRequired(
  prisma: PrismaClient,
  input: { reservationId: string; missingFields: string[] }
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    select: {
      id: true,
      reservationNumber: true,
      source: true,
      externalProvider: true,
      guestEmail: true,
      guestPhone: true,
      propertyId: true,
      property: { select: { name: true, organizationId: true } },
    },
  });

  if (!reservation || String(reservation.externalProvider ?? "").toUpperCase() !== "CHANNEX") {
    return { sent: 0, skipped: true, reason: "NOT_CHANNEX" } as const;
  }
  const issue = await prisma.operationalIssue.findUnique({
    where: { operationalKey: `GUEST_CONTACT_RECOVERY:${input.reservationId}` },
    select: { workflowState: true },
  });
  if (issue?.workflowState !== "ACTION_REQUIRED") {
    return { sent: 0, skipped: true, reason: "NOT_ACTION_REQUIRED" } as const;
  }

  const organizationId = reservation.property.organizationId;
  let recipients = await prisma.dashboardUser.findMany({
    where: { organizationId, isActive: true, role: DashboardUserRole.ORG_ADMIN },
    select: { email: true, fullName: true },
    orderBy: { createdAt: "asc" },
  });
  if (recipients.length === 0) {
    recipients = await prisma.dashboardUser.findMany({
      where: { organizationId, isActive: true },
      select: { email: true, fullName: true },
      orderBy: { createdAt: "asc" },
    });
  }

  let sent = 0;
  for (const recipient of recipients) {
    const to = clean(recipient.email).toLowerCase();
    if (!to) continue;
    const alreadySent = await prisma.messageLog.findFirst({
      where: {
        reservationId: reservation.id,
        organizationId,
        communicationType: TYPE,
        channel: "email",
        to,
        status: "SENT",
      },
      select: { id: true },
    });
    if (alreadySent) continue;

    const reservationNumber = reservation.reservationNumber ?? reservation.id;
    const subject = `Guest contact information required — Reservation #${reservationNumber}`;
    const result = await sendLoggedEmail({
      prisma,
      type: TYPE,
      to,
      subject,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId,
      retryPayload: {
        reservationNumber,
        missingFields: input.missingFields,
      },
      send: () => sendGuestContactRecoveryHostNotice({
        to,
        hostName: recipient.fullName,
        reservationNumber,
        propertyName: reservation.property.name,
        sourceName: clean(reservation.source) || "OTA",
        missingFields: input.missingFields,
        reservationDetailUrl: `${appUrl()}/reservations/${encodeURIComponent(reservation.id)}`,
        idempotencyKey: `guest-contact-recovery:${reservation.id}:${to}`,
      }),
    });
    if (result.ok) sent += 1;
  }

  return { sent, skipped: false } as const;
}
