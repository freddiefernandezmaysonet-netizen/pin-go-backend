import assert from "node:assert/strict";
import test from "node:test";

import {
  PaymentState,
  ReservationStatus,
  type PrismaClient,
} from "@prisma/client";

import { executeGuestJourneyComplianceOwnerAdapter } from "./guest-journey-compliance-owner-adapter.service";
import type { ClaimedComplianceIntent } from "./guest-journey-compliance-owner-runtime.service";

function claim(
  intentType:
    | "REQUEST_REQUIREMENTS_SNAPSHOT"
    | "REQUEST_GUEST_VERIFICATION" = "REQUEST_REQUIREMENTS_SNAPSHOT"
): ClaimedComplianceIntent {
  return {
    intentId: "intent-1",
    intentKey: "intent-key",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "COMPLIANCE",
    intentType,
    expectedOutcomeCode: intentType === "REQUEST_REQUIREMENTS_SNAPSHOT"
      ? "REQUIREMENTS_SNAPSHOTS_PRESENT"
      : "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED",
    inputEvidenceFingerprint: "input-fingerprint",
    attemptNumber: 1,
    leaseToken: "lease-token",
    leaseExpiresAt: new Date("2026-08-24T13:01:00.000Z"),
  };
}

function reservation(input: Partial<any> = {}) {
  return {
    id: "reservation-1",
    propertyId: "property-1",
    status: ReservationStatus.ACTIVE,
    paymentState: PaymentState.PAID,
    checkOut: new Date("2026-08-26T15:00:00.000Z"),
    guestToken: input.guestToken ?? null,
    guestTokenExpiresAt: input.guestTokenExpiresAt ?? null,
    guestAgreementSnapshot: input.guestAgreementSnapshot ?? null,
    guestAgreementAcceptance: input.guestAgreementAcceptance ?? null,
    guestAgreementSignedAt: input.guestAgreementSignedAt ?? null,
    verificationAcceptedRulesAt: input.verificationAcceptedRulesAt ?? null,
    cancellationPolicySnapshot: input.cancellationPolicySnapshot ?? null,
    cancellationPolicyId: input.cancellationPolicyId ?? null,
    identityVerificationRequiredSnapshot:
      input.identityVerificationRequiredSnapshot ?? null,
    verificationStatus: input.verificationStatus ?? "PENDING",
    verifiedAt: input.verifiedAt ?? null,
    identityVerificationConsentAt: input.identityVerificationConsentAt ?? null,
    identityDeclaredLegalName: input.identityDeclaredLegalName ?? null,
    identityVerificationAttempts: input.identityVerificationAttempts ?? 0,
    stripeIdentityVerificationSessionId:
      input.stripeIdentityVerificationSessionId ?? null,
    stripeIdentityVerificationStatus:
      input.stripeIdentityVerificationStatus ?? null,
    stripeIdentityVerificationLastError:
      input.stripeIdentityVerificationLastError ?? null,
    property: { organizationId: "org-1" },
  };
}

function fakePrisma(initial: any) {
  let current = { ...initial };
  const updates: any[] = [];
  return {
    updates,
    reservation: {
      findUnique: async () => current,
      update: async ({ data }: any) => {
        updates.push(data);
        current = { ...current, ...data };
        return current;
      },
    },
  } as unknown as PrismaClient & { updates: any[] };
}

test("E10 snapshots adapter captures bounded legal snapshots and guest token without external calls", async () => {
  const prisma = fakePrisma(reservation());
  const result = await executeGuestJourneyComplianceOwnerAdapter(
    prisma,
    claim("REQUEST_REQUIREMENTS_SNAPSHOT"),
    {
      now: new Date("2026-08-24T13:00:00.000Z"),
      dependencies: {
        tokenFactory: () => "token-1",
        ensureAgreementSnapshot: async (db: any) => {
          const snapshot = {
            requiresIdentityVerification: false,
            capturedAt: "2026-08-24T13:00:00.000Z",
          };
          await db.reservation.update({
            where: { id: "reservation-1" },
            data: { guestAgreementSnapshot: snapshot },
          });
          return {
            ok: true,
            alreadyCaptured: false,
            snapshot,
          };
        },
        buildCancellationSnapshot: async () => ({
          policyId: "policy-1",
          name: "Flexible",
          type: "FLEXIBLE",
        } as any),
      },
    }
  );

  assert.equal(result.providerCalls, 0);
  assert.equal(result.externalSideEffects, 0);
  assert.equal(result.internalMutations, 4);
  assert.equal(result.completion.kind, "SUCCEEDED");
  assert.equal(result.completion.action, "REQUIREMENTS_SNAPSHOTS_PRESENT");
  assert.equal(prisma.updates.some((item) => item.guestToken === "token-1"), true);
  assert.equal(
    prisma.updates.some((item) => item.identityVerificationRequiredSnapshot === false),
    true
  );
});

test("E10 verification adapter marks identity-not-required complete only after guest acceptance evidence exists", async () => {
  const now = new Date("2026-08-24T13:00:00.000Z");
  const prisma = fakePrisma(reservation({
    guestToken: "token-1",
    guestTokenExpiresAt: new Date("2026-08-28T15:00:00.000Z"),
    guestAgreementSnapshot: { requiresIdentityVerification: false },
    guestAgreementAcceptance: { accepted: true },
    guestAgreementSignedAt: now,
    verificationAcceptedRulesAt: now,
    cancellationPolicySnapshot: { policyId: "policy-1" },
    identityVerificationRequiredSnapshot: false,
  }));

  const result = await executeGuestJourneyComplianceOwnerAdapter(
    prisma,
    claim("REQUEST_GUEST_VERIFICATION"),
    { now }
  );

  assert.equal(result.providerCalls, 0);
  assert.equal(result.externalSideEffects, 0);
  assert.equal(result.completion.kind, "SUCCEEDED");
  assert.equal(result.completion.action, "IDENTITY_NOT_REQUIRED_MARKED_COMPLETE");
  assert.equal(
    prisma.updates.some((item) => item.verificationStatus === "NOT_REQUIRED"),
    true
  );
});

test("E10 verification adapter waits for guest or provider evidence and does not create Identity sessions", async () => {
  const now = new Date("2026-08-24T13:00:00.000Z");
  const prisma = fakePrisma(reservation({
    guestToken: "token-1",
    guestTokenExpiresAt: new Date("2026-08-28T15:00:00.000Z"),
    guestAgreementSnapshot: { requiresIdentityVerification: true },
    cancellationPolicySnapshot: { policyId: "policy-1" },
    identityVerificationRequiredSnapshot: true,
  }));

  const result = await executeGuestJourneyComplianceOwnerAdapter(
    prisma,
    claim("REQUEST_GUEST_VERIFICATION"),
    { now }
  );

  assert.equal(result.providerCalls, 0);
  assert.equal(result.externalSideEffects, 0);
  assert.equal(result.completion.kind, "WAITING_FOR_EVIDENCE");
  assert.match(result.completion.errorDetail, /AGREEMENT_ACCEPTANCE_MISSING/);
  assert.match(result.completion.errorDetail, /IDENTITY_PROVIDER_EVIDENCE_PENDING/);
});

test("E10 adapter rejects non-COMPLIANCE contracts", async () => {
  const prisma = fakePrisma(reservation());
  await assert.rejects(
    executeGuestJourneyComplianceOwnerAdapter(
      prisma,
      {
        ...claim(),
        targetEngine: "FINANCIAL" as never,
      }
    ),
    /COMPLIANCE_ADAPTER_CONTRACT_MISMATCH/
  );
});
