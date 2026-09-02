import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../prisma/migrations/20260902010000_add_enterprise_reviews_e1/migration.sql", import.meta.url), "utf8");
const service = readFileSync(new URL("./review.service.ts", import.meta.url), "utf8");
const evidenceService = readFileSync(new URL("./review-moderation-evidence.service.ts", import.meta.url), "utf8");
const modificationApplyService = readFileSync(new URL("../guest-reservation-modification-apply.service.ts", import.meta.url), "utf8");

function prismaEnumValues(name: string): string[] {
  const body = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`))?.[1];
  assert.ok(body, `${name} must exist in Prisma schema`);
  return body.split(/\s+/).filter(Boolean);
}

function migrationEnumValues(name: string): string[] {
  const body = migration.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`))?.[1];
  assert.ok(body, `${name} must exist in the E1 migration`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test("keeps the response-revision kind enum synchronized between Prisma and SQL", () => {
  assert.deepEqual(
    migrationEnumValues("PropertyReviewResponseRevisionKind"),
    prismaEnumValues("PropertyReviewResponseRevisionKind"),
  );
});

test("persists reviews as a reservation-bound independent and auditable domain", () => {
  assert.match(schema, /model PropertyReview \{[\s\S]*?reservationId\s+String\s+@unique/);
  assert.match(schema, /model PropertyReview \{[\s\S]*?firstPublishedAt\s+DateTime\?/);
  assert.match(schema, /model PropertyReview \{[\s\S]*?moderationVersion\s+Int\s+@default\(0\)/);
  assert.match(schema, /model PropertyReviewResponseRevision \{[\s\S]*?@@unique\(\[responseId, revision\]\)/);
  assert.match(schema, /enum PropertyReviewResponseRevisionKind \{[\s\S]*?HOST_WRITE[\s\S]*?MODERATION_HOLD[\s\S]*?MODERATION_PUBLISH[\s\S]*?MODERATION_REMOVE/);
  assert.match(schema, /model PropertyReviewResponseRevision \{[\s\S]*?kind\s+PropertyReviewResponseRevisionKind[\s\S]*?reasonCode\s+PropertyReviewModerationReason\?[\s\S]*?note\s+String\?/);
  assert.match(schema, /model PropertyReviewModerationEvent \{[\s\S]*?policyVersion\s+String/);

  assert.match(migration, /PropertyReview_ratings_check/);
  assert.match(migration, /PropertyReview_publication_state_check/);
  assert.match(migration, /PropertyReviewModerationCase_one_active_case_per_review/);
  assert.match(migration, /"firstPublishedAt"\s+TIMESTAMP/);
  assert.match(migration, /"moderationVersion"\s+INTEGER\s+NOT NULL\s+DEFAULT 0/);
  assert.match(migration, /CREATE TABLE "PropertyReviewResponseRevision"/);
  assert.match(migration, /CREATE TYPE "PropertyReviewResponseRevisionKind" AS ENUM \('HOST_WRITE', 'MODERATION_HOLD', 'MODERATION_PUBLISH', 'MODERATION_REMOVE'\)/);
  assert.match(migration, /PropertyReviewResponseRevision_kind_state_check/);
  assert.match(migration, /PropertyReviewResponseRevision_note_check/);
  assert.match(migration, /PropertyReviewResponseRevision_reason_matrix_check/);
  assert.match(migration, /'UPHELD'/);
  assert.match(migration, /enforce_property_review_scope/);
  assert.match(migration, /PropertyReviewModerationEvent_append_only_guard/);
  assert.match(migration, /PropertyReviewResponseRevision_append_only_guard/);
  assert.doesNotMatch(migration, /TRIGGER "Reservation_review|TRIGGER "Property_review/);
  assert.doesNotMatch(migration, /TG_TABLE_NAME = 'Reservation'|TG_TABLE_NAME = 'Property'/);
  assert.match(migration, /PropertyReviewModerationEvent_caseId_fkey[\s\S]*?ON DELETE RESTRICT/);
  assert.match(migration, /^-- Enterprise Reviews E1[^\n]*\nBEGIN;/);
  assert.match(migration, /BEGIN;\s*SET LOCAL search_path = public, pg_catalog;/);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION "enforce_property_review_scope"\(\)[\s\S]*?SECURITY INVOKER\s*SET search_path = pg_catalog, public\s*AS \$\$/,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION "reject_property_review_audit_mutation"\(\)[\s\S]*?SECURITY INVOKER\s*SET search_path = pg_catalog, public\s*AS \$\$/,
  );
  assert.match(migration, /COMMIT;\s*$/);
});

test("stores a recipient-bound encrypted token and rotates only when identity changes", () => {
  assert.match(schema, /model PropertyReviewInvitation \{[\s\S]*?tokenHash\s+String\s+@unique\s+@db\.VarChar\(64\)/);
  assert.match(schema, /model PropertyReviewInvitation \{[\s\S]*?tokenCiphertext\s+String\s+@db\.Text/);
  assert.match(schema, /model PropertyReviewInvitation \{[\s\S]*?recipientEmailHash\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /model PropertyReviewInvitation \{[\s\S]*?providerAcceptedAt\s+DateTime\?/);
  assert.match(schema, /model PropertyReviewInvitation \{[\s\S]*?deliveryStatus\s+PropertyReviewInvitationDeliveryStatus\s+@default\(PENDING\)/);
  assert.match(migration, /"tokenCiphertext"\s+TEXT\s+NOT NULL/);
  assert.match(migration, /PropertyReviewInvitation_recipient_email_hash_check/);

  const existingInvitationBranch = service.slice(
    service.indexOf("if (reservation.reviewInvitation)"),
    service.indexOf("const rawToken = crypto.randomBytes"),
  );
  assert.match(existingInvitationBranch, /recipientEmailHash !== currentRecipientEmailHash/);
  assert.match(existingInvitationBranch, /const replacementToken = crypto\.randomBytes\(32\)/);
  assert.match(existingInvitationBranch, /propertyReviewInvitation\.updateMany\(\{[\s\S]*?tokenHash: reservation\.reviewInvitation\.tokenHash[\s\S]*?recipientEmailHash: reservation\.reviewInvitation\.recipientEmailHash[\s\S]*?status: reservation\.reviewInvitation\.status/);
  assert.match(existingInvitationBranch, /return readActiveInvitationAfterCas\(/);
  assert.match(service, /const token = decryptReviewToken\(persisted\.tokenCiphertext\)/);
  assert.match(service, /tokenHash\(token\) !== persisted\.tokenHash/);
  assert.match(service, /reviewInvitation\?\.status === "REVOKED"[\s\S]*?REVIEW_INVITATION_REVOKED/);

  assert.match(service, /tokenHash: tokenHash\(rawToken\)/);
  assert.match(service, /tokenCiphertext: encryptReviewToken\(rawToken\)/);
  assert.match(service, /status: "INVITED", invitedAt: now, deliveryStatus: "PENDING"/);
  assert.match(service, /markReviewInvitationDelivery[\s\S]*?status: "INVITED"[\s\S]*?deliveryStatus: "SENT"/);
  assert.match(service, /providerAcceptedAt,/);
  assert.match(service, /tokenHash: input\.deliveryFence\.tokenHash/);
  assert.match(service, /recipientEmailHash: input\.deliveryFence\.recipientEmailHash/);
  assert.match(service, /reservation:\s*\{\s*guestEmail: input\.deliveryFence\.recipientEmail/);
  assert.match(service, /recordProviderAttempt/);
  assert.match(service, /const lastDeliveryError = normalizeReviewDeliveryError\(input\.error\)/);
});

test("review availability follows the reservation's current checkout", () => {
  assert.match(service, /export function reviewInvitationExpiresAt\(checkOut: Date\)/);
  assert.match(service, /export async function syncReviewInvitationExpiry/);
  assert.match(
    service,
    /if \(\["EXPIRED", "REVOKED"\]\.includes\(invitation\.status\)\) \{[\s\S]*?return invitation;/,
    "expired generations must remain closed until explicit token rotation",
  );
  assert.match(service, /expiresAt,\s*canSubmit: invitation\.reservation\.checkOut <= now/);
  assert.match(
    modificationApplyService,
    /if \(plan\.datesChanged\) \{[\s\S]*?assertProposedDatesAvailable\(/,
    "the existing availability collision check must remain independent of Reviews E1",
  );
  assert.doesNotMatch(
    modificationApplyService,
    /if \(plan\.datesChanged && reviewsE1Enabled\(\)\) \{[\s\S]{0,160}?assertProposedDatesAvailable\(/,
  );
  assert.doesNotMatch(
    modificationApplyService,
    /ReviewInvitation|reviewsE1Enabled|syncReviewInvitationExpiry/,
    "Reservation modification must not own the Reviews lifecycle",
  );
  assert.doesNotMatch(
    migration,
    /"status" NOT IN \('INVITED', 'CONSUMED'\) OR "deliveryStatus" = 'SENT'/,
    "provider delivery audit must not be an authorization dependency for a link already in the guest's possession",
  );
});

test("submission atomically enforces checkout eligibility, scope and single use", () => {
  assert.match(service, /assertReviewStayEligible\(reservation, \{ requireCheckoutCompleted: false, now \}\)/);
  assert.match(service, /return prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(service, /assertReviewStayEligible\(invitation\.reservation, \{ requireCheckoutCompleted: true, now \}\)/);
  assert.match(service, /REVIEW_TOKEN_RECIPIENT_CHANGED/);
  assert.match(service, /const expiresAt = reviewInvitationExpiresAt\(invitation\.reservation\.checkOut\)/);
  assert.match(service, /REVIEW_INVITATION_SCOPE_INVALID/);
  assert.match(service, /tx\.propertyReview\.create/);
  assert.match(service, /tx\.propertyReviewInvitation\.update[\s\S]*?status: "CONSUMED"/);
  assert.match(service, /tx\.propertyReviewModerationCase\.create/);
  assert.match(service, /const privateSignals = privateFeedback[\s\S]*?detectSafetySignals\(privateFeedback\)/);
  assert.match(
    service,
    /initialReviewDecision\([\s\S]*?ratings\.overallRating,[\s\S]*?signals,[\s\S]*?reviewAutoPublishEnabled\(\)/,
    "submission must consult the independent default-off auto-publication gate",
  );
  assert.match(
    service,
    /stayMonth: new Date\([\s\S]*?formatInTimeZone\([\s\S]*?invitation\.property\.timezone[\s\S]*?"yyyy-MM"/,
    "the public stay month must follow the property's local calendar",
  );
});

test("submission locks the reservation before re-reading mutable eligibility state", () => {
  const submissionFlow = service.slice(
    service.indexOf("export async function submitReview"),
    service.indexOf("export async function getPublicPropertyReviews"),
  );
  const identityLookup = submissionFlow.indexOf("const invitationIdentity");
  const rowLock = submissionFlow.indexOf('FROM "Reservation"');
  const lockedInvitationRead = submissionFlow.indexOf("const invitation = await tx.propertyReviewInvitation.findUnique", rowLock);
  const recipientCheck = submissionFlow.indexOf("REVIEW_TOKEN_RECIPIENT_CHANGED", lockedInvitationRead);
  const checkoutCheck = submissionFlow.indexOf("reviewInvitationExpiresAt(invitation.reservation.checkOut)", lockedInvitationRead);
  const eligibilityCheck = submissionFlow.indexOf("assertReviewStayEligible(invitation.reservation", lockedInvitationRead);
  const consumeFence = submissionFlow.indexOf("const consumed = await tx.propertyReviewInvitation.updateMany", lockedInvitationRead);

  assert.ok(identityLookup >= 0 && rowLock > identityLookup, "the opaque token may only resolve the reservation identity before locking");
  assert.match(submissionFlow, /SELECT "id"[\s\S]*?FROM "Reservation"[\s\S]*?WHERE "id" = \$\{invitationIdentity\.reservationId\}[\s\S]*?FOR UPDATE/);
  assert.ok(lockedInvitationRead > rowLock, "the invitation and reservation must be re-read after the row lock");
  assert.ok(recipientCheck > lockedInvitationRead && checkoutCheck > lockedInvitationRead && eligibilityCheck > lockedInvitationRead);
  assert.ok(consumeFence > eligibilityCheck, "the token is consumed only after locked eligibility validation");
  assert.match(submissionFlow, /const consumed = await tx\.propertyReviewInvitation\.updateMany\(\{[\s\S]*?tokenHash: hash,[\s\S]*?recipientEmailHash: invitation\.recipientEmailHash,[\s\S]*?status: "INVITED"/);
});

test("invitation token rotation is CAS-fenced and a lost race re-reads the winner", () => {
  const creationFlow = service.slice(
    service.indexOf("export async function createReviewInvitation"),
    service.indexOf("export async function markReviewInvitationDelivery"),
  );
  const replacement = creationFlow.indexOf("const replacementToken");
  const cas = creationFlow.indexOf("propertyReviewInvitation.updateMany", replacement);
  const winnerRead = creationFlow.indexOf("return readActiveInvitationAfterCas", cas);

  assert.ok(replacement >= 0 && cas > replacement && winnerRead > cas);
  assert.match(creationFlow, /propertyReviewInvitation\.updateMany\(\{[\s\S]*?tokenHash: reservation\.reviewInvitation\.tokenHash,[\s\S]*?recipientEmailHash: reservation\.reviewInvitation\.recipientEmailHash,[\s\S]*?status: reservation\.reviewInvitation\.status,[\s\S]*?consumedAt: null/);
  assert.match(creationFlow, /tokenHash: tokenHash\(replacementToken\)[\s\S]*?tokenCiphertext: encryptReviewToken\(replacementToken\)/);
  assert.doesNotMatch(creationFlow, /\["EXPIRED", "REVOKED"\]\.includes/);
  assert.ok(
    creationFlow.indexOf('status === "REVOKED"') < creationFlow.indexOf("const replacementToken"),
    "a revoked invitation must fail closed before any token rotation",
  );
});

test("moderation uses a server-generated evidence snapshot and optimistic fencing", () => {
  const moderationFlow = service.slice(service.indexOf("export async function moderateReview("));
  assert.match(service, /const evidenceSnapshot = await buildReviewModerationEvidence\(reviewId, now\)/);
  assert.match(service, /assertEvidenceReference\(evidenceSnapshot, moderatorEvidence\?\.reference\)/);
  assert.match(service, /const evidence = buildReviewModerationDecisionEvidence\([\s\S]*?evidenceSnapshot,[\s\S]*?moderatorEvidence\?\.reference/);
  assert.match(service, /review\.moderationVersion !== expectedVersion/);
  assert.match(service, /updateMany\([\s\S]*?moderationVersion: expectedVersion, status: review\.status[\s\S]*?moderationVersion: \{ increment: 1 \}/);

  assert.match(service, /action === "UPHOLD"[\s\S]*?MODERATION_CASE_REQUIRED/);
  assert.match(service, /MODERATION_SAFETY_OVERRIDE_NOTE_REQUIRED/);
  assert.match(service, /action === "REMOVE"[\s\S]*?review\.status !== "HELD_FOR_REVIEW"[\s\S]*?!review\.firstPublishedAt/);
  assert.match(service, /firstPublishedAt: target === "PUBLISHED" \? \(review\.firstPublishedAt \?\? now\) : review\.firstPublishedAt/);
  assert.match(service, /action === "UPHOLD" \? "UPHELD"/);
  assert.ok(
    moderationFlow.indexOf("requireModerationEvidence") < moderationFlow.indexOf("return prisma.$transaction"),
    "reason/action policy must run before moderation writes",
  );
});

test("terminal review statuses cannot re-enter dispute moderation", () => {
  const disputeFlow = service.slice(
    service.indexOf("export async function disputeReview"),
    service.indexOf("export async function moderateReview("),
  );
  assert.match(disputeFlow, /review\.status === "REMOVED" \|\| review\.status === "REJECTED"/);
  assert.match(disputeFlow, /REVIEW_DISPUTE_STATUS_INVALID/);
  assert.ok(
    disputeFlow.indexOf("REVIEW_DISPUTE_STATUS_INVALID") < disputeFlow.indexOf("propertyReview.updateMany"),
    "terminal status guard must run before dispute writes",
  );
});

test("opening a dispute advances the moderation CAS while published reviews remain visible", () => {
  const disputeFlow = service.slice(
    service.indexOf("export async function disputeReview"),
    service.indexOf("export async function moderateReview("),
  );
  assert.match(disputeFlow, /select: \{ id: true, propertyId: true, status: true, moderationVersion: true \}/);
  assert.match(disputeFlow, /const reviewStatus = review\.status === "PUBLISHED" \? "PUBLISHED" : "DISPUTED"/);
  assert.match(disputeFlow, /propertyReview\.updateMany\(\{[\s\S]*?status: review\.status,[\s\S]*?moderationVersion: review\.moderationVersion,[\s\S]*?moderationVersion: \{ increment: 1 \}/);
  assert.match(disputeFlow, /updated\.count !== 1[\s\S]*?MODERATION_VERSION_CONFLICT/);
  assert.match(disputeFlow, /reviewStatus,[\s\S]*?moderationVersion: review\.moderationVersion \+ 1/);
});

test("operational moderation evidence is assembled by the server from Pin&Go records", () => {
  assert.match(evidenceService, /kind: "PIN_GO_REVIEW_MODERATION_EVIDENCE"/);
  assert.match(evidenceService, /guestJourney:/);
  assert.match(evidenceService, /accessGrants:/);
  assert.match(evidenceService, /prisma\.messageLog\.findMany/);
  assert.match(evidenceService, /prisma\.apmsAuditEntry\.findMany/);
  assert.match(evidenceService, /snapshot\.referenceIds\.includes\(normalized\)/);
  assert.match(evidenceService, /MODERATION_EVIDENCE_REFERENCE_INVALID/);
  assert.match(evidenceService, /snapshotSha256:/);
  assert.match(evidenceService, /selectedReference/);
});

test("host response edits append revisions instead of erasing history", () => {
  assert.match(service, /revisions: \{ create: \{ revision: 1/);
  assert.match(service, /revision: 1,[\s\S]*?kind: "HOST_WRITE"/);
  assert.match(service, /const nextRevision = existing\.revision \+ 1/);
  assert.match(service, /propertyReviewResponse\.updateMany/);
  assert.match(service, /propertyReviewResponseRevision\.create/);
  assert.match(service, /REVIEW_RESPONSE_VERSION_CONFLICT/);
  assert.match(service, /existing\.status !== "PUBLISHED"[\s\S]*?REVIEW_RESPONSE_STATUS_INVALID/);
  assert.match(service, /propertyReviewResponse\.updateMany\(\{ where: \{ id: existing\.id, revision: existing\.revision, status: "PUBLISHED" \}/);
});

test("host-response moderation is CAS-fenced and preserves the exact body", () => {
  const responseModeration = service.slice(
    service.indexOf("export async function moderateReviewResponse"),
    service.indexOf("export async function disputeReview"),
  );
  assert.match(responseModeration, /requireResponseModerationDecision\(action, reasonCode, note\)/);
  assert.match(responseModeration, /response\.revision !== expectedRevision/);
  assert.match(responseModeration, /assertResponseModerationTransition\(response\.status, action\)/);
  assert.match(responseModeration, /propertyReviewResponse\.updateMany\([\s\S]*?status: response\.status,[\s\S]*?revision: expectedRevision/);
  assert.match(responseModeration, /revision: nextRevision,[\s\S]*?authorUserId: actorUserId,[\s\S]*?body: response\.body,[\s\S]*?kind,[\s\S]*?reasonCode,[\s\S]*?note/);
  assert.doesNotMatch(responseModeration, /body:\s*normalizeReviewText|body:\s*note/);
});

test("moderation queue returns response status and revision while public reads filter held responses", () => {
  const queueRead = service.slice(
    service.indexOf("export async function listReviewModerationQueue"),
    service.indexOf("export async function respondToReview"),
  );
  assert.match(queueRead, /response: \{ isNot: null \}/);
  assert.match(queueRead, /response: true/);

  const publicRead = service.slice(
    service.indexOf("export async function getPublicPropertyReviews"),
    service.indexOf("export async function listOrganizationReviews"),
  );
  assert.match(publicRead, /response: \{ where: \{ status: "PUBLISHED" \}/);
});

test("public reputation totals, averages and rows share one database snapshot", () => {
  const publicRead = service.slice(
    service.indexOf("export async function getPublicPropertyReviews"),
    service.indexOf("export async function listOrganizationReviews"),
  );
  assert.match(publicRead, /prisma\.\$transaction\(\[/);
  assert.match(
    publicRead,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/,
  );
});
