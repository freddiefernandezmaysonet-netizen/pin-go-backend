import {
  Prisma,
  PrismaClient,
} from "@prisma/client";
import type { AuditEntry } from "../apms/audit-types";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import {
  ensureReservationGuestAgreementSnapshot,
} from "./guest-agreement.service";
import {
  completeGuestJourneyVerification,
  ensureGuestJourneyForConfirmedReservation,
} from "./guest-journey.service";
import {
  evaluateGuestAccessReadiness,
} from "./guest-access-readiness.service";

const INTERNAL_DEMO_SOURCE =
  "INTERNAL_DEMO_CENTER";

type InternalDemoActor = {
  userId: string;
  organizationId: string;
  email: string | null;
  role: string;
};

type InternalDemoDependencies = {
  ensureAgreementSnapshot:
    typeof ensureReservationGuestAgreementSnapshot;
  ensureGuestJourney:
    typeof ensureGuestJourneyForConfirmedReservation;
  completeGuestJourney:
    typeof completeGuestJourneyVerification;
  evaluateReadiness:
    typeof evaluateGuestAccessReadiness;
  persistAudit: typeof persistAuditEntry;
};

const defaultDependencies: InternalDemoDependencies = {
  ensureAgreementSnapshot:
    ensureReservationGuestAgreementSnapshot,
  ensureGuestJourney:
    ensureGuestJourneyForConfirmedReservation,
  completeGuestJourney:
    completeGuestJourneyVerification,
  evaluateReadiness:
    evaluateGuestAccessReadiness,
  persistAudit: persistAuditEntry,
};

function readSnapshot(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "INTERNAL_DEMO_GUEST_AGREEMENT_SNAPSHOT_INVALID"
    );
  }

  return value as Record<string, unknown>;
}

export async function completeInternalDemoSecurePrecheckin(
  prisma: PrismaClient,
  input: {
    reservationId: string;
    actor: InternalDemoActor;
    delivery?: {
      preferredLanguage?: "es" | "en";
      smsConsent?: boolean;
    };
    now?: Date;
  },
  dependencies: InternalDemoDependencies =
    defaultDependencies
) {
  const reservationId = String(
    input.reservationId ?? ""
  ).trim();
  const actorUserId = String(
    input.actor?.userId ?? ""
  ).trim();
  const actorOrganizationId = String(
    input.actor?.organizationId ?? ""
  ).trim();

  if (input.actor?.role !== "PLATFORM_ADMIN") {
    throw new Error(
      "INTERNAL_DEMO_PLATFORM_ADMIN_REQUIRED"
    );
  }

  if (
    !reservationId ||
    !actorUserId ||
    !actorOrganizationId
  ) {
    throw new Error(
      "INTERNAL_DEMO_RESERVATION_AND_ACTOR_REQUIRED"
    );
  }

  const reservation =
    await prisma.reservation.findUnique({
      where: {
        id: reservationId,
      },
      select: {
        id: true,
        externalId: true,
        externalProvider: true,
        guestName: true,
        propertyId: true,
        externalRaw: true,
        property: {
          select: {
            organizationId: true,
          },
        },
      },
    });

  if (!reservation) {
    throw new Error(
      "INTERNAL_DEMO_RESERVATION_NOT_FOUND"
    );
  }

  if (
    reservation.externalProvider !== "LODGIFY" ||
    !String(reservation.externalId ?? "").startsWith(
      "DEMO-"
    )
  ) {
    throw new Error(
      "INTERNAL_DEMO_RESERVATION_REQUIRED"
    );
  }

  if (
    reservation.property.organizationId !==
    actorOrganizationId
  ) {
    throw new Error(
      "INTERNAL_DEMO_ORGANIZATION_MISMATCH"
    );
  }

  const now = input.now ?? new Date();
  const acceptedAt = now.toISOString();
  const preferredLanguage =
    input.delivery?.preferredLanguage === "es"
      ? "es"
      : "en";
  const smsConsent =
    input.delivery?.smsConsent === true;
  const existingExternalRaw =
    reservation.externalRaw &&
    typeof reservation.externalRaw === "object" &&
    !Array.isArray(reservation.externalRaw)
      ? (reservation.externalRaw as Record<
          string,
          unknown
        >)
      : {};
  const existingConsent =
    existingExternalRaw.consent &&
    typeof existingExternalRaw.consent === "object" &&
    !Array.isArray(existingExternalRaw.consent)
      ? (existingExternalRaw.consent as Record<
          string,
          unknown
        >)
      : {};

  return prisma.$transaction(async (tx) => {
    await dependencies.ensureGuestJourney(
      tx as any,
      reservation.id
    );

    const agreementResult =
      await dependencies.ensureAgreementSnapshot(
        tx as any,
        reservation.id
      );

    if (!agreementResult.ok || !agreementResult.snapshot) {
      throw new Error(
        "INTERNAL_DEMO_ACTIVE_GUEST_AGREEMENT_REQUIRED"
      );
    }

    const snapshot = readSnapshot(
      agreementResult.snapshot
    );

    if (snapshot.propertyId !== reservation.propertyId) {
      throw new Error(
        "INTERNAL_DEMO_GUEST_AGREEMENT_PROPERTY_MISMATCH"
      );
    }

    const requiresIdentityVerification =
      snapshot.requiresIdentityVerification !== false;
    const acceptance = {
      accepted: true,
      acceptedAt,
      source: INTERNAL_DEMO_SOURCE,
      simulated: true,
      demoOnly: true,
      agreementId:
        typeof snapshot.agreementId === "string"
          ? snapshot.agreementId
          : null,
      agreementVersion:
        typeof snapshot.version === "string"
          ? snapshot.version
          : null,
      agreementTitle:
        typeof snapshot.title === "string"
          ? snapshot.title
          : null,
      agreementCapturedAt:
        typeof snapshot.capturedAt === "string"
          ? snapshot.capturedAt
          : null,
      legalName: reservation.guestName,
      guestCount: 1,
      authorizedGuestAccepted: true,
      agreementAccepted: true,
      rulesAccepted: true,
      identityConsentAccepted:
        requiresIdentityVerification,
      actorUserId,
    };
    const disclosureAcceptance = {
      accepted: true,
      acceptedAt,
      source: INTERNAL_DEMO_SOURCE,
      version:
        "internal_demo_secure_precheckin_v1",
      text:
        "Controlled internal demo: secure pre-check-in evidence was simulated for the Demo Center reservation.",
      simulated: true,
      demoOnly: true,
      actorUserId,
    };

    await tx.reservation.update({
      where: {
        id: reservation.id,
      },
      data: {
        preferredLanguage,
        externalRaw: {
          ...existingExternalRaw,
          consent: {
            ...existingConsent,
            stayNotificationsConsent:
              smsConsent,
            smsConsent,
            consentSource:
              INTERNAL_DEMO_SOURCE,
            consentVersion:
              "stay_notifications_v1",
            acceptedAt: smsConsent
              ? acceptedAt
              : null,
          },
        } as Prisma.InputJsonValue,
        verificationStatus:
          requiresIdentityVerification
            ? "COMPLETED"
            : "NOT_REQUIRED",
        verifiedAt: requiresIdentityVerification
          ? now
          : null,
        verificationGuestCount: 1,
        verificationAcceptedRulesAt: now,
        verificationUserAgent:
          INTERNAL_DEMO_SOURCE,
        guestAgreementAcceptance:
          acceptance as unknown as Prisma.InputJsonValue,
        guestAgreementSignedAt: now,
        securePreCheckinDisclosureAcceptance:
          disclosureAcceptance as unknown as Prisma.InputJsonValue,
        identityVerificationRequiredSnapshot:
          requiresIdentityVerification,
        identityVerificationConsentAt:
          requiresIdentityVerification ? now : null,
        identityDeclaredLegalName:
          reservation.guestName,
        identityVerifiedLegalName:
          requiresIdentityVerification
            ? reservation.guestName
            : null,
        identityNameMatchStatus:
          requiresIdentityVerification
            ? "MATCHED"
            : null,
        identityVerificationProvider:
          requiresIdentityVerification
            ? INTERNAL_DEMO_SOURCE
            : null,
      },
    });

    const guestJourney =
      await dependencies.completeGuestJourney(
        tx as any,
        reservation.id
      );
    const readiness =
      await dependencies.evaluateReadiness(
        tx as any,
        reservation.id,
        {
          persist: true,
          now,
        }
      );

    if (!readiness.ready) {
      throw new Error(
        `INTERNAL_DEMO_ACCESS_NOT_READY:${readiness.blockers.join(
          ","
        )}`
      );
    }

    const completedAt = new Date();
    const auditEntry: AuditEntry = {
      engine: "Access",
      decisionId:
        `internal-demo-secure-precheckin:${reservation.id}`,
      entityType: "RESERVATION",
      entityId: reservation.id,
      eventType: "DECISION_APPLIED",
      status: "SUCCESS",
      severity: "INFO",
      summary:
        "Demo Center secure pre-check-in evidence was simulated.",
      reason:
        "A platform administrator ran a controlled internal demo that must exercise the normal guest access engine without weakening production readiness checks.",
      startedAt: now,
      completedAt,
      durationMs:
        completedAt.getTime() - now.getTime(),
      decisions: [
        {
          engine: "Access",
          rule:
            "INTERNAL_DEMO_SECURE_PRECHECKIN",
          label:
            "Simulate Demo Secure Pre-check-in",
          previousValue: "PENDING",
          newValue: "ELIGIBLE",
          applied: true,
          metadata: {
            simulated: true,
            demoOnly: true,
            requiresIdentityVerification,
            preferredLanguage,
            smsConsent,
          },
        },
      ],
      metadata: {
        organizationId:
          reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        externalId: reservation.externalId,
        actorUserId,
        actorOrganizationId,
        actorEmail:
          input.actor.email ?? null,
        source: INTERNAL_DEMO_SOURCE,
        preferredLanguage,
        smsConsent,
        simulated: true,
        demoOnly: true,
      },
    };

    await dependencies.persistAudit(
      tx as any,
      auditEntry
    );

    return {
      reservationId: reservation.id,
      source: INTERNAL_DEMO_SOURCE,
      simulated: true,
      guestJourney,
      readiness,
    };
  });
}
