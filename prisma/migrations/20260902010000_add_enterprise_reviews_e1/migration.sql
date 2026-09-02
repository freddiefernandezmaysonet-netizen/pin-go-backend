-- Enterprise Reviews E1 is additive and remains runtime-disabled by default.
BEGIN;
SET LOCAL search_path = public, pg_catalog;

CREATE TYPE "PropertyReviewSource" AS ENUM ('PIN_GO_DIRECT', 'AIRBNB', 'BOOKING_COM', 'VRBO', 'EXPEDIA', 'IMPORTED_VERIFIED');
CREATE TYPE "PropertyReviewStatus" AS ENUM ('PENDING_MODERATION', 'PUBLISHED', 'DISPUTED', 'HELD_FOR_REVIEW', 'REJECTED', 'REMOVED');
CREATE TYPE "PropertyReviewInvitationStatus" AS ENUM ('ELIGIBLE', 'INVITED', 'CONSUMED', 'EXPIRED', 'REVOKED');
CREATE TYPE "PropertyReviewInvitationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');
CREATE TYPE "PropertyReviewResponseStatus" AS ENUM ('PUBLISHED', 'HELD_FOR_REVIEW', 'REMOVED');
CREATE TYPE "PropertyReviewResponseRevisionKind" AS ENUM ('HOST_WRITE', 'MODERATION_HOLD', 'MODERATION_PUBLISH', 'MODERATION_REMOVE');
CREATE TYPE "PropertyReviewModerationCaseStatus" AS ENUM ('OPEN', 'DISPUTED', 'RESOLVED_PUBLISHED', 'RESOLVED_REJECTED', 'RESOLVED_REMOVED');
CREATE TYPE "PropertyReviewModerationReason" AS ENUM ('AUTOMATED_SAFETY_CLEAR', 'ROUTINE_LOW_RATING_REVIEW', 'AUTOMATED_SAFETY_SIGNAL', 'UNVERIFIED_STAY', 'DUPLICATE', 'ABUSE_HARASSMENT', 'THREAT', 'EXTORTION', 'PII', 'SPAM', 'IRRELEVANT', 'FACTUALLY_CONTRADICTED', 'MANIPULATION', 'OTHER_POLICY');
CREATE TYPE "PropertyReviewModerationAction" AS ENUM ('CASE_OPENED', 'EVIDENCE_ADDED', 'DISPUTE_OPENED', 'PUBLISHED', 'UPHELD', 'REJECTED', 'HELD', 'REMOVED');

CREATE TABLE "PropertyReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "source" "PropertyReviewSource" NOT NULL DEFAULT 'PIN_GO_DIRECT',
    "status" "PropertyReviewStatus" NOT NULL DEFAULT 'PENDING_MODERATION',
    "overallRating" INTEGER NOT NULL,
    "cleanlinessRating" INTEGER NOT NULL,
    "accuracyRating" INTEGER NOT NULL,
    "checkInAccessRating" INTEGER NOT NULL,
    "communicationRating" INTEGER NOT NULL,
    "locationRating" INTEGER NOT NULL,
    "valueRating" INTEGER NOT NULL,
    "publicComment" TEXT NOT NULL,
    "privateFeedback" TEXT,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "guestDisplayName" VARCHAR(80) NOT NULL,
    "stayMonth" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "firstPublishedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "moderationVersion" INTEGER NOT NULL DEFAULT 0,
    "moderationPolicyVersion" VARCHAR(40) NOT NULL DEFAULT 'reviews_e1_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PropertyReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReview_ratings_check" CHECK (
      "overallRating" BETWEEN 1 AND 5 AND "cleanlinessRating" BETWEEN 1 AND 5 AND
      "accuracyRating" BETWEEN 1 AND 5 AND "checkInAccessRating" BETWEEN 1 AND 5 AND
      "communicationRating" BETWEEN 1 AND 5 AND "locationRating" BETWEEN 1 AND 5 AND
      "valueRating" BETWEEN 1 AND 5
    ),
    CONSTRAINT "PropertyReview_public_comment_check" CHECK (length(btrim("publicComment")) BETWEEN 1 AND 5000),
    CONSTRAINT "PropertyReview_private_feedback_check" CHECK ("privateFeedback" IS NULL OR length("privateFeedback") <= 5000),
    CONSTRAINT "PropertyReview_moderation_version_check" CHECK ("moderationVersion" >= 0),
    CONSTRAINT "PropertyReview_moderation_policy_version_check" CHECK (length(btrim("moderationPolicyVersion")) BETWEEN 1 AND 40),
    CONSTRAINT "PropertyReview_publication_state_check" CHECK (
      ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "firstPublishedAt" IS NOT NULL AND "removedAt" IS NULL) OR
      ("status" = 'REMOVED' AND "publishedAt" IS NULL AND "firstPublishedAt" IS NOT NULL AND "removedAt" IS NOT NULL) OR
      ("status" NOT IN ('PUBLISHED', 'REMOVED') AND "publishedAt" IS NULL AND "removedAt" IS NULL)
    ),
    CONSTRAINT "PropertyReview_publication_order_check" CHECK (
      ("publishedAt" IS NULL OR "firstPublishedAt" <= "publishedAt") AND
      ("removedAt" IS NULL OR "firstPublishedAt" <= "removedAt")
    )
);

CREATE TABLE "PropertyReviewInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "recipientEmailHash" VARCHAR(64) NOT NULL,
    "status" "PropertyReviewInvitationStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "tokenCiphertext" TEXT NOT NULL,
    "deliveryStatus" "PropertyReviewInvitationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAttemptAt" TIMESTAMP(3),
    "providerAcceptedAt" TIMESTAMP(3),
    "deliveryProviderMessageId" TEXT,
    "lastDeliveryError" TEXT,
    "deliveryLeaseOwner" VARCHAR(120),
    "deliveryLeaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PropertyReviewInvitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReviewInvitation_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PropertyReviewInvitation_recipient_email_hash_check" CHECK ("recipientEmailHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PropertyReviewInvitation_token_ciphertext_check" CHECK (length(btrim("tokenCiphertext")) > 0),
    CONSTRAINT "PropertyReviewInvitation_delivery_attempt_count_check" CHECK ("deliveryAttemptCount" >= 0),
    CONSTRAINT "PropertyReviewInvitation_expiration_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "PropertyReviewInvitation_consumed_state_check" CHECK (("status" = 'CONSUMED') = ("consumedAt" IS NOT NULL)),
    CONSTRAINT "PropertyReviewInvitation_invited_state_check" CHECK (
      "status" NOT IN ('INVITED', 'CONSUMED') OR "invitedAt" IS NOT NULL
    ),
    CONSTRAINT "PropertyReviewInvitation_status_delivery_check" CHECK (
      ("deliveryStatus" <> 'SENT' OR "status" IN ('INVITED', 'CONSUMED', 'EXPIRED', 'REVOKED'))
    ),
    CONSTRAINT "PropertyReviewInvitation_delivery_state_check" CHECK (
      ("deliveryStatus" = 'SENT' AND "providerAcceptedAt" IS NOT NULL AND "invitedAt" IS NOT NULL) OR
      ("deliveryStatus" <> 'SENT' AND "providerAcceptedAt" IS NULL)
    ),
    CONSTRAINT "PropertyReviewInvitation_delivery_error_check" CHECK (
      "deliveryStatus" <> 'FAILED' OR (
        "lastDeliveryError" IS NOT NULL AND length(btrim("lastDeliveryError")) BETWEEN 1 AND 5000
      )
    ),
    CONSTRAINT "PropertyReviewInvitation_delivery_attempt_state_check" CHECK (
      "deliveryStatus" NOT IN ('SENT', 'FAILED') OR (
        "deliveryAttemptCount" >= 1 AND "lastDeliveryAttemptAt" IS NOT NULL
      )
    ),
    CONSTRAINT "PropertyReviewInvitation_delivery_lease_check" CHECK (
      ("deliveryStatus" = 'PROCESSING' AND "deliveryLeaseOwner" IS NOT NULL AND "deliveryLeaseExpiresAt" IS NOT NULL) OR
      ("deliveryStatus" <> 'PROCESSING' AND "deliveryLeaseOwner" IS NULL AND "deliveryLeaseExpiresAt" IS NULL)
    )
);

CREATE TABLE "PropertyReviewResponse" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PropertyReviewResponseStatus" NOT NULL DEFAULT 'PUBLISHED',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PropertyReviewResponse_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReviewResponse_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "PropertyReviewResponse_publication_state_check" CHECK (("status" = 'PUBLISHED') = ("publishedAt" IS NOT NULL)),
    CONSTRAINT "PropertyReviewResponse_revision_check" CHECK ("revision" >= 1)
);

CREATE TABLE "PropertyReviewResponseRevision" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PropertyReviewResponseStatus" NOT NULL,
    "kind" "PropertyReviewResponseRevisionKind" NOT NULL DEFAULT 'HOST_WRITE',
    "reasonCode" "PropertyReviewModerationReason",
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PropertyReviewResponseRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReviewResponseRevision_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PropertyReviewResponseRevision_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "PropertyReviewResponseRevision_note_check" CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 20 AND 5000),
    CONSTRAINT "PropertyReviewResponseRevision_kind_state_check" CHECK (
      ("kind" = 'HOST_WRITE' AND "status" = 'PUBLISHED' AND "reasonCode" IS NULL AND "note" IS NULL)
      OR ("kind" = 'MODERATION_HOLD' AND "status" = 'HELD_FOR_REVIEW' AND "reasonCode" IS NOT NULL AND "note" IS NOT NULL)
      OR ("kind" = 'MODERATION_PUBLISH' AND "status" = 'PUBLISHED' AND "reasonCode" IS NOT NULL AND "note" IS NOT NULL)
      OR ("kind" = 'MODERATION_REMOVE' AND "status" = 'REMOVED' AND "reasonCode" IS NOT NULL AND "note" IS NOT NULL)
    ),
    CONSTRAINT "PropertyReviewResponseRevision_reason_matrix_check" CHECK (
      "kind" = 'HOST_WRITE'
      OR ("kind" = 'MODERATION_PUBLISH' AND "reasonCode" = 'AUTOMATED_SAFETY_CLEAR')
      OR ("kind" = 'MODERATION_HOLD' AND "reasonCode" IN ('AUTOMATED_SAFETY_SIGNAL', 'ABUSE_HARASSMENT', 'THREAT', 'EXTORTION', 'PII', 'SPAM', 'IRRELEVANT', 'FACTUALLY_CONTRADICTED', 'MANIPULATION'))
      OR ("kind" = 'MODERATION_REMOVE' AND "reasonCode" IN ('ABUSE_HARASSMENT', 'THREAT', 'EXTORTION', 'PII', 'SPAM', 'IRRELEVANT', 'FACTUALLY_CONTRADICTED', 'MANIPULATION'))
    )
);

CREATE TABLE "PropertyReviewModerationCase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "status" "PropertyReviewModerationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "reasonCode" "PropertyReviewModerationReason" NOT NULL,
    "evidence" JSONB,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PropertyReviewModerationCase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReviewModerationCase_resolution_check" CHECK (("status" IN ('OPEN', 'DISPUTED')) = ("resolvedAt" IS NULL))
);

CREATE TABLE "PropertyReviewModerationEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "PropertyReviewModerationAction" NOT NULL,
    "reasonCode" "PropertyReviewModerationReason",
    "evidence" JSONB,
    "note" TEXT,
    "policyVersion" VARCHAR(40) NOT NULL DEFAULT 'reviews_e1_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PropertyReviewModerationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyReviewModerationEvent_note_check" CHECK ("note" IS NULL OR length("note") <= 5000),
    CONSTRAINT "PropertyReviewModerationEvent_policy_version_check" CHECK (length(btrim("policyVersion")) BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX "PropertyReview_reservationId_key" ON "PropertyReview"("reservationId");
CREATE INDEX "PropertyReview_organizationId_status_submittedAt_idx" ON "PropertyReview"("organizationId", "status", "submittedAt");
CREATE INDEX "PropertyReview_propertyId_status_publishedAt_idx" ON "PropertyReview"("propertyId", "status", "publishedAt");
CREATE INDEX "PropertyReview_status_submittedAt_idx" ON "PropertyReview"("status", "submittedAt");
CREATE UNIQUE INDEX "PropertyReviewInvitation_reservationId_key" ON "PropertyReviewInvitation"("reservationId");
CREATE UNIQUE INDEX "PropertyReviewInvitation_tokenHash_key" ON "PropertyReviewInvitation"("tokenHash");
CREATE INDEX "PropertyReviewInvitation_organizationId_status_expiresAt_idx" ON "PropertyReviewInvitation"("organizationId", "status", "expiresAt");
CREATE INDEX "PropertyReviewInvitation_propertyId_status_idx" ON "PropertyReviewInvitation"("propertyId", "status");
CREATE INDEX "PropertyReviewInvitation_delivery_queue_idx" ON "PropertyReviewInvitation"("deliveryStatus", "deliveryLeaseExpiresAt", "expiresAt");
CREATE INDEX "PropertyReviewInvitation_status_expiresAt_idx" ON "PropertyReviewInvitation"("status", "expiresAt");
CREATE UNIQUE INDEX "PropertyReviewResponse_reviewId_key" ON "PropertyReviewResponse"("reviewId");
CREATE INDEX "PropertyReviewResponse_authorUserId_idx" ON "PropertyReviewResponse"("authorUserId");
CREATE UNIQUE INDEX "PropertyReviewResponseRevision_responseId_revision_key" ON "PropertyReviewResponseRevision"("responseId", "revision");
CREATE INDEX "PropertyReviewResponseRevision_authorUserId_createdAt_idx" ON "PropertyReviewResponseRevision"("authorUserId", "createdAt");
CREATE INDEX "PropertyReviewModerationCase_organizationId_status_openedAt_idx" ON "PropertyReviewModerationCase"("organizationId", "status", "openedAt");
CREATE INDEX "PropertyReviewModerationCase_reviewId_status_idx" ON "PropertyReviewModerationCase"("reviewId", "status");
CREATE INDEX "PropertyReviewModerationCase_status_openedAt_idx" ON "PropertyReviewModerationCase"("status", "openedAt");
CREATE UNIQUE INDEX "PropertyReviewModerationCase_one_active_case_per_review" ON "PropertyReviewModerationCase"("reviewId") WHERE "status" IN ('OPEN', 'DISPUTED');
CREATE INDEX "PropertyReviewModerationEvent_caseId_createdAt_idx" ON "PropertyReviewModerationEvent"("caseId", "createdAt");
CREATE INDEX "PropertyReviewModerationEvent_actorUserId_idx" ON "PropertyReviewModerationEvent"("actorUserId");

ALTER TABLE "PropertyReview" ADD CONSTRAINT "PropertyReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReview" ADD CONSTRAINT "PropertyReview_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReview" ADD CONSTRAINT "PropertyReview_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewInvitation" ADD CONSTRAINT "PropertyReviewInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewInvitation" ADD CONSTRAINT "PropertyReviewInvitation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewInvitation" ADD CONSTRAINT "PropertyReviewInvitation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewResponse" ADD CONSTRAINT "PropertyReviewResponse_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PropertyReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewResponse" ADD CONSTRAINT "PropertyReviewResponse_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "DashboardUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewResponseRevision" ADD CONSTRAINT "PropertyReviewResponseRevision_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "PropertyReviewResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewResponseRevision" ADD CONSTRAINT "PropertyReviewResponseRevision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "DashboardUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewModerationCase" ADD CONSTRAINT "PropertyReviewModerationCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewModerationCase" ADD CONSTRAINT "PropertyReviewModerationCase_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewModerationCase" ADD CONSTRAINT "PropertyReviewModerationCase_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PropertyReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewModerationEvent" ADD CONSTRAINT "PropertyReviewModerationEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "PropertyReviewModerationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReviewModerationEvent" ADD CONSTRAINT "PropertyReviewModerationEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "DashboardUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express these cross-table tenant invariants. The trigger takes
-- SHARE locks on the validated parent rows so a concurrent property/org move
-- cannot race a review, invitation, or moderation-case write.
CREATE OR REPLACE FUNCTION "enforce_property_review_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME IN ('PropertyReview', 'PropertyReviewInvitation') THEN
    PERFORM 1
      FROM "Reservation" AS reservation
      JOIN "Property" AS property ON property."id" = reservation."propertyId"
     WHERE reservation."id" = NEW."reservationId"
       AND reservation."propertyId" = NEW."propertyId"
       AND property."organizationId" = NEW."organizationId"
       FOR SHARE OF reservation, property;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Review scope does not match its reservation, property, and organization'
        USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_scope_check';
    END IF;

    IF TG_TABLE_NAME = 'PropertyReview' AND TG_OP = 'UPDATE' THEN
      IF EXISTS (
        SELECT 1
          FROM "PropertyReviewModerationCase" AS moderation_case
         WHERE moderation_case."reviewId" = OLD."id"
           AND (
             moderation_case."propertyId" IS DISTINCT FROM NEW."propertyId" OR
             moderation_case."organizationId" IS DISTINCT FROM NEW."organizationId"
           )
      ) THEN
        RAISE EXCEPTION 'Review scope cannot diverge from its moderation cases'
          USING ERRCODE = '23514', CONSTRAINT = 'PropertyReview_moderation_case_scope_check';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'PropertyReviewModerationCase' THEN
    PERFORM 1
      FROM "PropertyReview" AS review
     WHERE review."id" = NEW."reviewId"
       AND review."propertyId" = NEW."propertyId"
       AND review."organizationId" = NEW."organizationId"
       FOR SHARE OF review;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Moderation case scope does not match its review'
        USING ERRCODE = '23514', CONSTRAINT = 'PropertyReviewModerationCase_scope_check';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported table % for review scope enforcement', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "PropertyReview_scope_insert_guard" ON "PropertyReview";
CREATE TRIGGER "PropertyReview_scope_insert_guard"
BEFORE INSERT ON "PropertyReview"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

DROP TRIGGER IF EXISTS "PropertyReview_scope_update_guard" ON "PropertyReview";
CREATE TRIGGER "PropertyReview_scope_update_guard"
BEFORE UPDATE OF "reservationId", "propertyId", "organizationId" ON "PropertyReview"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

DROP TRIGGER IF EXISTS "PropertyReviewInvitation_scope_insert_guard" ON "PropertyReviewInvitation";
CREATE TRIGGER "PropertyReviewInvitation_scope_insert_guard"
BEFORE INSERT ON "PropertyReviewInvitation"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

DROP TRIGGER IF EXISTS "PropertyReviewInvitation_scope_update_guard" ON "PropertyReviewInvitation";
CREATE TRIGGER "PropertyReviewInvitation_scope_update_guard"
BEFORE UPDATE OF "reservationId", "propertyId", "organizationId" ON "PropertyReviewInvitation"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

DROP TRIGGER IF EXISTS "PropertyReviewModerationCase_scope_insert_guard" ON "PropertyReviewModerationCase";
CREATE TRIGGER "PropertyReviewModerationCase_scope_insert_guard"
BEFORE INSERT ON "PropertyReviewModerationCase"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

DROP TRIGGER IF EXISTS "PropertyReviewModerationCase_scope_update_guard" ON "PropertyReviewModerationCase";
CREATE TRIGGER "PropertyReviewModerationCase_scope_update_guard"
BEFORE UPDATE OF "reviewId", "propertyId", "organizationId" ON "PropertyReviewModerationCase"
FOR EACH ROW EXECUTE FUNCTION "enforce_property_review_scope"();

-- Moderation decisions and response-history revisions are immutable audit
-- records. Statement-level guards also reject TRUNCATE as a DELETE bypass.
CREATE OR REPLACE FUNCTION "reject_property_review_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "PropertyReviewModerationEvent_append_only_guard" ON "PropertyReviewModerationEvent";
CREATE TRIGGER "PropertyReviewModerationEvent_append_only_guard"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "PropertyReviewModerationEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_property_review_audit_mutation"();

DROP TRIGGER IF EXISTS "PropertyReviewResponseRevision_append_only_guard" ON "PropertyReviewResponseRevision";
CREATE TRIGGER "PropertyReviewResponseRevision_append_only_guard"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "PropertyReviewResponseRevision"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_property_review_audit_mutation"();

COMMIT;
