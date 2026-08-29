-- APMS Owner Attempt DB Contract Closure
-- Expand the durable owner-attempt allowlist to the canonical E5/E7/E8/E9/E10
-- Engine + intent + handler combinations. Preserve fail-closed behavior for
-- every unknown or mismatched combination.

BEGIN;

ALTER TABLE "GuestJourneyCoordinationIntentAttempt"
DROP CONSTRAINT "GuestJourneyCoordinationIntentAttempt_target_check";

ALTER TABLE "GuestJourneyCoordinationIntentAttempt"
ADD CONSTRAINT "GuestJourneyCoordinationIntentAttempt_target_check"
CHECK (
  (
    "targetEngine" = 'ACCESS' AND
    "intentType" = 'REQUEST_ACCESS_EVALUATION' AND
    "handlerCode" = 'ACCESS_EVALUATION_V1'
  ) OR
  (
    "targetEngine" = 'ACCESS' AND
    "intentType" = 'REQUEST_ACCESS_PROVISIONING' AND
    "handlerCode" = 'ACCESS_PROVISIONING_V1'
  ) OR
  (
    "targetEngine" = 'ACCESS' AND
    "intentType" = 'REQUEST_ACCESS_REVOCATION_CHECK' AND
    "handlerCode" = 'ACCESS_REVOCATION_CHECK_V1'
  ) OR
  (
    "targetEngine" = 'COMMUNICATIONS' AND
    "intentType" = 'REQUEST_COMMUNICATION' AND
    "handlerCode" = 'COMMUNICATION_RETRY_V1'
  ) OR
  (
    "targetEngine" = 'COMMUNICATIONS' AND
    "intentType" = 'REQUEST_COMMUNICATION_RETRY' AND
    "handlerCode" = 'COMMUNICATION_RETRY_V1'
  ) OR
  (
    "targetEngine" = 'FINANCIAL' AND
    "intentType" = 'REQUEST_PAYMENT_EVALUATION' AND
    "handlerCode" = 'PAYMENT_EVALUATION_V1'
  ) OR
  (
    "targetEngine" = 'COMPLIANCE' AND
    "intentType" = 'REQUEST_REQUIREMENTS_SNAPSHOT' AND
    "handlerCode" = 'REQUIREMENTS_SNAPSHOT_V1'
  ) OR
  (
    "targetEngine" = 'COMPLIANCE' AND
    "intentType" = 'REQUEST_GUEST_VERIFICATION' AND
    "handlerCode" = 'GUEST_VERIFICATION_V1'
  )
);

COMMIT;
