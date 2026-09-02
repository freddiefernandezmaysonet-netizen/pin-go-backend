import assert from "node:assert/strict";
import test from "node:test";
import { reviewInvitationDispatcherEnabled, reviewsE1Enabled } from "./reviews.config.js";

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
