import { createHash, randomBytes } from "node:crypto";

import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import { buildCancellationPolicySnapshot } from "./cancellation-policy.service";
import { ensureReservationGuestAgreementSnapshot } from "./guest-agreement.service";
import type {
  ClaimedComplianceIntent,
  ComplianceOwnerCompletion,
} from "./guest-journey-compliance-owner-runtime.service";

const reservationSelect = {
  id: true,
  propertyId: true,
  status: true,
  paymentState: true,
  checkOut: true,
  guestToken: true,
  guestTokenExpiresAt: true,
  guestAgreementSnapshot: true,
  guestAgreementAcceptance: true,
  guestAgreementSignedAt: true,
  verificationAcceptedRulesAt: true,
  cancellationPolicySnapshot: true,
  cancellationPolicyId: true,
  identityVerificationRequiredSnapshot: true,
  verificationStatus: true,
  verifiedAt: true,
  identityVerificationConsentAt: true,
  identityDeclaredLegalName: true,
  identityVerificationAttempts: true,
  stripeIdentityVerificationSessionId: true,
  stripeIdentityVerificationStatus: true,
  stripeIdentityVerificationLastError: true,
  property: { select: { organizationId: true } },
} satisfies Prisma.ReservationSelect;

type ReservationComplianceSnapshot = Prisma.ReservationGetPayload<{
  select: typeof reservationSelect;
}>;

type AdapterDependencies = {
  ensureAgreementSnapshot: typeof ensureReservationGuestAgreementSnapshot;
  buildCancellationSnapshot: typeof buildCancellationPolicySnapshot;
  tokenFactory: () => string;
};

const DEFAULT_DEPENDENCIES: AdapterDependencies = {
  ensureAgreementSnapshot: ensureReservationGuestAgreementSnapshot,
  buildCancellationSnapshot: buildCancellationPolicySnapshot,
  tokenFactory: () => randomBytes(16).toString("hex"),
};

export type ComplianceOwnerAdapterResult = {
  providerCalls: 0;
  externalSideEffects: 0;
  internalMutations: number;
  completion: ComplianceOwnerCompletion;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasJsonObject(value: unknown): boolean {
  return isJsonObject(value) && Object.keys(value).length > 0;
}

function accepted(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  return value.accepted === true || value.signed === true;
}

function readAgreementRequiresIdentity(value: unknown): boolean | null {
  if (!isJsonObject(value)) return null;
  return value.requiresIdentityVerification === false ? false : true;
}

function tokenValid(
  reservation: Pick<ReservationComplianceSnapshot, "guestToken" | "guestTokenExpiresAt">,
  now: Date
): boolean {
  return Boolean(reservation.guestToken) &&
    Boolean(reservation.guestTokenExpiresAt) &&
    reservation.guestTokenExpiresAt!.getTime() > now.getTime();
}

function tokenExpiresAt(checkOut: Date): Date {
  return new Date(checkOut.getTime() + 48 * 60 * 60 * 1000);
}

function evidenceFingerprint(snapshot: ReservationComplianceSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({
      reservationId: snapshot.id,
      status: snapshot.status,
      paymentState: snapshot.paymentState,
      guestTokenPresent: Boolean(snapshot.guestToken),
      guestTokenExpiresAt: snapshot.guestTokenExpiresAt?.toISOString() ?? null,
      agreementSnapshotPresent: hasJsonObject(snapshot.guestAgreementSnapshot),
      agreementAccepted: accepted(snapshot.guestAgreementAcceptance),
      agreementSignedAt: snapshot.guestAgreementSignedAt?.toISOString() ?? null,
      rulesAcceptedAt: snapshot.verificationAcceptedRulesAt?.toISOString() ?? null,
      cancellationSnapshotPresent: hasJsonObject(snapshot.cancellationPolicySnapshot),
      identityVerificationRequiredSnapshot: snapshot.identityVerificationRequiredSnapshot,
      verificationStatus: snapshot.verificationStatus,
      verifiedAt: snapshot.verifiedAt?.toISOString() ?? null,
      identityConsentAt: snapshot.identityVerificationConsentAt?.toISOString() ?? null,
      identityLegalNamePresent: Boolean(String(snapshot.identityDeclaredLegalName ?? "").trim()),
      identityAttempts: snapshot.identityVerificationAttempts,
      stripeIdentitySessionPresent: Boolean(snapshot.stripeIdentityVerificationSessionId),
      stripeIdentityStatus: snapshot.stripeIdentityVerificationStatus,
      stripeIdentityLastErrorPresent: Boolean(snapshot.stripeIdentityVerificationLastError),
    }))
    .digest("hex");
}

function assertClaimContract(claim: ClaimedComplianceIntent): void {
  if (claim.targetEngine !== "COMPLIANCE") {
    throw new Error("GUEST_JOURNEY_COMPLIANCE_ADAPTER_CONTRACT_MISMATCH");
  }
  if (
    claim.intentType === "REQUEST_REQUIREMENTS_SNAPSHOT" &&
    claim.expectedOutcomeCode === "REQUIREMENTS_SNAPSHOTS_PRESENT"
  ) {
    return;
  }
  if (
    claim.intentType === "REQUEST_GUEST_VERIFICATION" &&
    claim.expectedOutcomeCode === "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED"
  ) {
    return;
  }
  throw new Error("GUEST_JOURNEY_COMPLIANCE_ADAPTER_CONTRACT_MISMATCH");
}

function assertScope(
  claim: ClaimedComplianceIntent,
  snapshot: ReservationComplianceSnapshot
): void {
  if (
    snapshot.propertyId !== claim.propertyId ||
    snapshot.property.organizationId !== claim.organizationId
  ) {
    throw new Error("GUEST_JOURNEY_COMPLIANCE_ADAPTER_SCOPE_MISMATCH");
  }
}

async function loadReservation(
  prisma: PrismaClient,
  reservationId: string
): Promise<ReservationComplianceSnapshot> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: reservationSelect,
  });
  if (!reservation) {
    throw new Error("GUEST_JOURNEY_COMPLIANCE_RESERVATION_NOT_FOUND");
  }
  return reservation;
}

async function ensureSnapshotsAndToken(
  prisma: PrismaClient,
  reservation: ReservationComplianceSnapshot,
  now: Date,
  dependencies: AdapterDependencies
): Promise<{ mutations: number; missingConfiguration: string[] }> {
  let mutations = 0;
  const missingConfiguration: string[] = [];

  if (!hasJsonObject(reservation.guestAgreementSnapshot)) {
    const result = await dependencies.ensureAgreementSnapshot(
      prisma,
      reservation.id
    );
    if (!result.ok) {
      missingConfiguration.push(
        result.reason ?? "ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND"
      );
    } else if (!result.alreadyCaptured) {
      mutations += 1;
    }
  }

  if (!hasJsonObject(reservation.cancellationPolicySnapshot)) {
    try {
      const snapshot = await dependencies.buildCancellationSnapshot(
        reservation.propertyId
      );
      const policyId = isJsonObject(snapshot) && typeof snapshot.policyId === "string"
        ? snapshot.policyId
        : null;
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          cancellationPolicySnapshot: snapshot as unknown as Prisma.InputJsonValue,
          cancellationPolicyId: policyId,
        },
      });
      mutations += 1;
    } catch {
      missingConfiguration.push("ACTIVE_PROPERTY_CANCELLATION_POLICY_NOT_FOUND");
    }
  }

  const refreshed = await loadReservation(prisma, reservation.id);
  const requiresIdentity = readAgreementRequiresIdentity(
    refreshed.guestAgreementSnapshot
  );
  if (
    requiresIdentity !== null &&
    refreshed.identityVerificationRequiredSnapshot !== requiresIdentity
  ) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { identityVerificationRequiredSnapshot: requiresIdentity },
    });
    mutations += 1;
  }

  if (
    refreshed.status === ReservationStatus.ACTIVE &&
    refreshed.checkOut.getTime() > now.getTime() &&
    !tokenValid(refreshed, now)
  ) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        guestToken: refreshed.guestToken ?? dependencies.tokenFactory(),
        guestTokenExpiresAt: tokenExpiresAt(refreshed.checkOut),
      },
    });
    mutations += 1;
  }

  return { mutations, missingConfiguration };
}

function requirementsSatisfied(
  snapshot: ReservationComplianceSnapshot,
  now: Date
): boolean {
  return hasJsonObject(snapshot.guestAgreementSnapshot) &&
    hasJsonObject(snapshot.cancellationPolicySnapshot) &&
    typeof snapshot.identityVerificationRequiredSnapshot === "boolean" &&
    tokenValid(snapshot, now);
}

function verificationSatisfied(snapshot: ReservationComplianceSnapshot): boolean {
  const requiresIdentity = readAgreementRequiresIdentity(
    snapshot.guestAgreementSnapshot
  );
  const legalAccepted = accepted(snapshot.guestAgreementAcceptance) &&
    Boolean(snapshot.guestAgreementSignedAt) &&
    Boolean(snapshot.verificationAcceptedRulesAt) &&
    hasJsonObject(snapshot.cancellationPolicySnapshot);
  if (!legalAccepted) return false;
  if (requiresIdentity === false) {
    return snapshot.verificationStatus === "NOT_REQUIRED" &&
      Boolean(snapshot.verifiedAt);
  }
  return snapshot.verificationStatus === "COMPLETED" &&
    Boolean(snapshot.verifiedAt);
}

function verificationMissingEvidence(snapshot: ReservationComplianceSnapshot): string[] {
  const missing: string[] = [];
  const requiresIdentity = readAgreementRequiresIdentity(
    snapshot.guestAgreementSnapshot
  );
  if (!accepted(snapshot.guestAgreementAcceptance)) missing.push("AGREEMENT_ACCEPTANCE_MISSING");
  if (!snapshot.guestAgreementSignedAt) missing.push("AGREEMENT_SIGNATURE_MISSING");
  if (!snapshot.verificationAcceptedRulesAt) missing.push("PROPERTY_RULES_ACCEPTANCE_MISSING");
  if (!hasJsonObject(snapshot.cancellationPolicySnapshot)) missing.push("CANCELLATION_POLICY_SNAPSHOT_MISSING");
  if (requiresIdentity === true) {
    if (!snapshot.identityVerificationConsentAt) missing.push("IDENTITY_CONSENT_MISSING");
    if (!String(snapshot.identityDeclaredLegalName ?? "").trim()) missing.push("IDENTITY_LEGAL_NAME_MISSING");
    if (
      snapshot.verificationStatus !== "COMPLETED" ||
      !snapshot.verifiedAt
    ) {
      missing.push("IDENTITY_PROVIDER_EVIDENCE_PENDING");
    }
  }
  if (requiresIdentity === null) missing.push("IDENTITY_REQUIREMENT_SNAPSHOT_MISSING");
  return missing.sort();
}

async function markIdentityNotRequiredComplete(
  prisma: PrismaClient,
  snapshot: ReservationComplianceSnapshot,
  now: Date
): Promise<number> {
  if (
    readAgreementRequiresIdentity(snapshot.guestAgreementSnapshot) !== false ||
    !accepted(snapshot.guestAgreementAcceptance) ||
    !snapshot.guestAgreementSignedAt ||
    !snapshot.verificationAcceptedRulesAt ||
    snapshot.verificationStatus === "NOT_REQUIRED"
  ) {
    return 0;
  }
  await prisma.reservation.update({
    where: { id: snapshot.id },
    data: {
      verificationStatus: "NOT_REQUIRED",
      verifiedAt: snapshot.verifiedAt ?? now,
      identityVerificationConsentAt: null,
    },
  });
  return 1;
}

export async function executeGuestJourneyComplianceOwnerAdapter(
  prisma: PrismaClient,
  claim: ClaimedComplianceIntent,
  options: { now?: Date; dependencies?: Partial<AdapterDependencies> } = {}
): Promise<ComplianceOwnerAdapterResult> {
  assertClaimContract(claim);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("GUEST_JOURNEY_COMPLIANCE_ADAPTER_NOW_INVALID");
  }

  const initial = await loadReservation(prisma, claim.reservationId);
  assertScope(claim, initial);

  if (
    initial.status !== ReservationStatus.ACTIVE ||
    initial.checkOut.getTime() <= now.getTime()
  ) {
    return {
      providerCalls: 0,
      externalSideEffects: 0,
      internalMutations: 0,
      completion: {
        kind: "SUCCEEDED",
        action: "COMPLIANCE_NOT_REQUIRED_FOR_TERMINAL_RESERVATION",
        verificationStatus: initial.verificationStatus,
        outcomeEvidenceFingerprint: evidenceFingerprint(initial),
      },
    };
  }

  let internalMutations = 0;
  const ensured = await ensureSnapshotsAndToken(
    prisma,
    initial,
    now,
    dependencies
  );
  internalMutations += ensured.mutations;
  if (ensured.missingConfiguration.length > 0) {
    const refreshed = await loadReservation(prisma, claim.reservationId);
    return {
      providerCalls: 0,
      externalSideEffects: 0,
      internalMutations,
      completion: {
        kind: "EXHAUSTED",
        verificationStatus: refreshed.verificationStatus,
        outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
        errorCode: "COMPLIANCE_CONFIGURATION_MISSING",
        errorDetail: ensured.missingConfiguration.join(","),
      },
    };
  }

  let refreshed = await loadReservation(prisma, claim.reservationId);
  if (claim.intentType === "REQUEST_REQUIREMENTS_SNAPSHOT") {
    if (requirementsSatisfied(refreshed, now)) {
      return {
        providerCalls: 0,
        externalSideEffects: 0,
        internalMutations,
        completion: {
          kind: "SUCCEEDED",
          action: "REQUIREMENTS_SNAPSHOTS_PRESENT",
          verificationStatus: refreshed.verificationStatus,
          outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
        },
      };
    }
    return {
      providerCalls: 0,
      externalSideEffects: 0,
      internalMutations,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        verificationStatus: refreshed.verificationStatus,
        outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
        errorCode: "REQUIREMENTS_SNAPSHOT_EVIDENCE_PENDING",
        errorDetail: "The required legal snapshots or guest token are not yet persistently satisfied.",
      },
    };
  }

  if (refreshed.paymentState !== PaymentState.PAID) {
    return {
      providerCalls: 0,
      externalSideEffects: 0,
      internalMutations,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        verificationStatus: refreshed.verificationStatus,
        outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
        errorCode: "COMPLIANCE_PAYMENT_EVIDENCE_PENDING",
        errorDetail: "Guest verification remains blocked until canonical payment evidence is PAID.",
      },
    };
  }

  internalMutations += await markIdentityNotRequiredComplete(
    prisma,
    refreshed,
    now
  );
  refreshed = await loadReservation(prisma, claim.reservationId);

  if (verificationSatisfied(refreshed)) {
    return {
      providerCalls: 0,
      externalSideEffects: 0,
      internalMutations,
      completion: {
        kind: "SUCCEEDED",
        action: readAgreementRequiresIdentity(refreshed.guestAgreementSnapshot) === false
          ? "IDENTITY_NOT_REQUIRED_MARKED_COMPLETE"
          : "GUEST_VERIFICATION_ALREADY_SATISFIED",
        verificationStatus: refreshed.verificationStatus,
        outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
      },
    };
  }

  const missing = verificationMissingEvidence(refreshed);
  return {
    providerCalls: 0,
    externalSideEffects: 0,
    internalMutations,
    completion: {
      kind: "WAITING_FOR_EVIDENCE",
      verificationStatus: refreshed.verificationStatus,
      outcomeEvidenceFingerprint: evidenceFingerprint(refreshed),
      errorCode: "GUEST_VERIFICATION_EVIDENCE_PENDING",
      errorDetail: missing.length > 0
        ? missing.join(",")
        : "Guest verification evidence is not yet complete. E10 does not create Stripe Identity sessions or contact the guest.",
    },
  };
}
