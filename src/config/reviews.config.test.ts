import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewAutoPublishEnabled,
  reviewInvitationDispatcherEnabled,
  reviewInvitationEligibleAfter,
  reviewsE1Enabled,
} from "./reviews.config.js";

test("Reviews E1 is default-off and requires an explicit true value", () => {
  assert.equal(reviewsE1Enabled({} as NodeJS.ProcessEnv), false);
  assert.equal(reviewsE1Enabled({ PINGO_REVIEWS_E1_ENABLED: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(reviewsE1Enabled({ PINGO_REVIEWS_E1_ENABLED: "true" } as NodeJS.ProcessEnv), true);
});

test("review invitation delivery requires both independent flags", () => {
  assert.equal(reviewInvitationDispatcherEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(reviewInvitationDispatcherEnabled({
    PINGO_REVIEWS_E1_ENABLED: "true",
  } as NodeJS.ProcessEnv), false);
  assert.equal(reviewInvitationDispatcherEnabled({
    PINGO_REVIEWS_E1_ENABLED: "true",
    PINGO_REVIEW_INVITATION_DISPATCH_ENABLED: "true",
  } as NodeJS.ProcessEnv), true);
});

test("review auto-publication is default-off and requires Reviews E1", () => {
  assert.equal(reviewAutoPublishEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(reviewAutoPublishEnabled({
    PINGO_REVIEW_AUTO_PUBLISH_ENABLED: "true",
  } as NodeJS.ProcessEnv), false);
  assert.equal(reviewAutoPublishEnabled({
    PINGO_REVIEWS_E1_ENABLED: "true",
    PINGO_REVIEW_AUTO_PUBLISH_ENABLED: "false",
  } as NodeJS.ProcessEnv), false);
  assert.equal(reviewAutoPublishEnabled({
    PINGO_REVIEWS_E1_ENABLED: "true",
    PINGO_REVIEW_AUTO_PUBLISH_ENABLED: "true",
  } as NodeJS.ProcessEnv), true);
});

test("review invitation launch cutoff is mandatory and timezone-explicit", () => {
  assert.throws(
    () => reviewInvitationEligibleAfter({} as NodeJS.ProcessEnv),
    /ELIGIBLE_AFTER_REQUIRED/
  );
  assert.throws(
    () => reviewInvitationEligibleAfter({
      PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER: "2026-09-02T17:30:00",
    } as NodeJS.ProcessEnv),
    /TIMEZONE_REQUIRED/
  );
  assert.throws(
    () => reviewInvitationEligibleAfter({
      PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER: "not-a-dateZ",
    } as NodeJS.ProcessEnv),
    /ELIGIBLE_AFTER_INVALID/
  );

  assert.equal(
    reviewInvitationEligibleAfter({
      PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER: "2026-09-02T17:30:00-04:00",
    } as NodeJS.ProcessEnv).toISOString(),
    "2026-09-02T21:30:00.000Z"
  );
});
