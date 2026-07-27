-- Pin&Go Prisma migration-history reconciliation
-- Part 3 of 5. Remaining 18 missing tables.
-- Do not apply to an existing database unless the schema-equivalence preflight has passed.

BEGIN;
-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "offsetMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAction" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalUid" TEXT,
    "linkedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAutomationSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "arrivalOffsetMinutes" INTEGER NOT NULL DEFAULT 30,
    "departureOffsetMinutes" INTEGER NOT NULL DEFAULT 15,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "guestExperienceDevices" JSONB,
    "guestExperienceEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PropertyAutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAutomationDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalDeviceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "deviceCategory" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "autoOffAtCheckOut" BOOLEAN NOT NULL DEFAULT true,
    "autoOnAtCheckIn" BOOLEAN NOT NULL DEFAULT true,
    "deviceProfile" TEXT,
    "profileDetectedAt" TIMESTAMP(3),
    "profileSource" TEXT,
    "tuyaFunctions" JSONB,

    CONSTRAINT "PropertyAutomationDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecutionLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT,
    "trigger" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deviceName" TEXT,
    "deviceCategory" TEXT,
    "externalId" TEXT,
    "action" TEXT,
    "value" JSONB,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingAppointment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "topic" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "googleEventId" TEXT,
    "googleMeetLink" TEXT,
    "remoteAssistanceRequested" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "bookingType" "BookingType" NOT NULL DEFAULT 'ONBOARDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesFollowUp" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "bookingType" "BookingType" NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'DEMO_SALES_FOLLOW_UP',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAmenity" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "chargeMode" "AmenityChargeMode" NOT NULL DEFAULT 'INCLUDED',
    "feeType" "AmenityFeeType" NOT NULL DEFAULT 'PER_STAY',
    "amount" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyAmenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyTax" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyBlockedDate" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyBlockedDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyCancellationPolicy" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CancellationPolicyType" NOT NULL DEFAULT 'FLEXIBLE',
    "source" TEXT NOT NULL DEFAULT 'CUSTOM',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "guestSelfCancellationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoRefundEligibleCancellations" BOOLEAN NOT NULL DEFAULT true,
    "requireHostApprovalOutsidePolicy" BOOLEAN NOT NULL DEFAULT true,
    "freeCancellationHoursBeforeCheckIn" INTEGER NOT NULL DEFAULT 168,
    "refundBasis" "CancellationRefundBasis" NOT NULL DEFAULT 'TOTAL_AMOUNT',
    "refundPercentBeforeDeadline" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "refundPercentAfterDeadline" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "cleaningFeeRefundable" BOOLEAN NOT NULL DEFAULT true,
    "amenitiesRefundable" BOOLEAN NOT NULL DEFAULT true,
    "taxesRefundable" BOOLEAN NOT NULL DEFAULT true,
    "nonRefundableDiscountPercent" DECIMAL(5,2),
    "refundRules" JSONB,
    "nonRefundableScenarios" JSONB,
    "guestFacingSummary" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyCancellationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApmsAuditEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "propertyId" TEXT,
    "reservationId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "eventType" TEXT,
    "status" TEXT NOT NULL,
    "severity" TEXT,
    "decisionId" TEXT NOT NULL,
    "summary" TEXT,
    "reason" TEXT,
    "decisions" JSONB,
    "recommendedAction" TEXT,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApmsAuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyGuestAgreement" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agreementText" TEXT NOT NULL,
    "rules" JSONB,
    "guestFacingSummary" TEXT,
    "titleEn" TEXT,
    "titleEs" TEXT,
    "agreementTextEn" TEXT,
    "agreementTextEs" TEXT,
    "rulesEn" JSONB,
    "rulesEs" JSONB,
    "guestFacingSummaryEn" TEXT,
    "guestFacingSummaryEs" TEXT,
    "requiresIdentityVerification" BOOLEAN NOT NULL DEFAULT true,
    "requiresAgreementSignature" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyGuestAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationNumberCounter" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssue" (
    "id" TEXT NOT NULL,
    "operationalKey" TEXT NOT NULL,
    "issueCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "operationalImpact" TEXT,
    "recommendedAction" TEXT,
    "nextAutomaticStep" TEXT,
    "engine" TEXT NOT NULL,
    "severity" "OperationalSeverity" NOT NULL,
    "workflowState" "OperationalWorkflowState" NOT NULL,
    "visibility" "OperationalVisibility" NOT NULL,
    "responsibleActor" "OperationalActor" NOT NULL,
    "actionRequired" BOOLEAN NOT NULL,
    "canAutoResolve" BOOLEAN NOT NULL,
    "autoResolveStatus" "OperationalAutoResolveStatus" NOT NULL DEFAULT 'NOT_SUPPORTED',
    "autoResolveActionCode" TEXT,
    "autoResolveAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAutoResolveAttemptAt" TIMESTAMP(3),
    "lastAutoResolveError" TEXT,
    "organizationId" TEXT,
    "propertyId" TEXT,
    "reservationId" TEXT,
    "guestName" TEXT,
    "staffMemberId" TEXT,
    "cleanerName" TEXT,
    "decisionId" TEXT,
    "sourceAuditEntryId" TEXT,
    "sourceType" "OperationalSourceType" NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolutionCode" TEXT,
    "resolutionSummary" TEXT,
    "resolutionType" "OperationalResolutionType",
    "resolvedBy" "OperationalActor",
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "actionTarget" "OperationalActionTarget" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssueTransition" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "operationalKey" TEXT NOT NULL,
    "issueCode" TEXT NOT NULL,
    "fromWorkflowState" "OperationalWorkflowState",
    "toWorkflowState" "OperationalWorkflowState" NOT NULL,
    "transitionCode" TEXT NOT NULL,
    "transitionSummary" TEXT NOT NULL,
    "transitionedBy" "OperationalActor" NOT NULL,
    "sourceType" "OperationalSourceType" NOT NULL,
    "decisionId" TEXT,
    "sourceAuditEntryId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "OperationalIssueTransition_pkey" PRIMARY KEY ("id")
);
COMMIT;
