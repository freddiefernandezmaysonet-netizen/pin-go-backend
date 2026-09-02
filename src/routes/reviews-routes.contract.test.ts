import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboard = readFileSync(new URL("./dashboard.reviews.routes.ts", import.meta.url), "utf8");
const publicRoutes = readFileSync(new URL("./public-reviews.routes.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

test("all review surfaces are default-off", () => {
  assert.match(dashboard, /reviewsE1Enabled\(\)/);
  assert.match(publicRoutes, /reviewsE1Enabled\(\)/);
  assert.match(
    publicRoutes,
    /publicReviewsRouter\.use\("\/api\/public-reviews"/,
    "the disabled review gate must not intercept unrelated application routes",
  );
  assert.doesNotMatch(
    publicRoutes,
    /publicReviewsRouter\.use\(\(_req, res, next\)/,
  );
});

test("production CORS does not trust local development origins", () => {
  assert.match(
    server,
    /const localDevelopmentOrigins = process\.env\.NODE_ENV === "production"[\s\S]*?\? \[\][\s\S]*?: \["http:\/\/localhost:5173", "http:\/\/localhost:4173"\]/,
  );
  assert.match(server, /\.\.\.localDevelopmentOrigins/);
});

test("organization mutations require an active tenant actor", () => {
  assert.match(dashboard, /verifiedOrganizationActor/);
  assert.match(dashboard, /organizationId: actor\.orgId/);
  assert.match(dashboard, /respondToReview\(actor\.organizationId, actor\.id/);
  assert.match(dashboard, /disputeReview\(actor\.organizationId, actor\.id/);
});

test("only a database-verified platform admin can moderate across tenants", () => {
  assert.match(dashboard, /actor\.role !== "PLATFORM_ADMIN"/);
  assert.match(dashboard, /role: "PLATFORM_ADMIN", isActive: true/);
  assert.match(dashboard, /verifiedPlatformModerator\(req, res\)/);
  assert.match(dashboard, /\["PUBLISH", "UPHOLD", "REJECT", "REMOVE", "HOLD"\]\.includes\(action\)/);
  assert.match(dashboard, /req\.body\?\.evidence, req\.body\?\.expectedVersion/);
  assert.match(dashboard, /moderation\/:id\/evidence/);
  assert.match(dashboard, /buildReviewModerationEvidence\(String\(req\.params\.id\)\)/);
  assert.match(dashboard, /\/api\/dashboard\/reviews\/:id\/response\/moderate/);
  assert.match(dashboard, /response: await moderateReviewResponse\([\s\S]*?actor\.id/);
  assert.match(dashboard, /RESPONSE_MODERATION_ACTIONS/);
  assert.match(dashboard, /req\.body\?\.expectedRevision/);
});

test("cookie-authenticated review mutations use the origin guard", () => {
  assert.match(dashboard, /response"[\s\S]*?requireTrustedReviewMutationOrigin/);
  assert.match(dashboard, /disputes"[\s\S]*?requireTrustedReviewMutationOrigin/);
  assert.match(dashboard, /moderate"[\s\S]*?requireTrustedReviewMutationOrigin/);
  assert.match(dashboard, /response\/moderate"[\s\S]*?requireTrustedReviewMutationOrigin/);
  assert.match(dashboard, /response\/moderate"[\s\S]*?reviewResponseModerationMutationLimit/);
});

test("public reputation lookup requires a currently public property", () => {
  assert.match(publicRoutes, /status: "ACTIVE", isPublicBookable: true/);
  assert.match(publicRoutes, /publicBookingEnabled: true/);
});

test("guest review secrets are read from authorization, never URL parameters", () => {
  assert.match(publicRoutes, /"\/api\/public-reviews\/invitation"/);
  assert.match(publicRoutes, /"\/api\/public-reviews\/submissions"/);
  assert.match(publicRoutes, /reviewTokenFromRequest\(req\)/);
  assert.doesNotMatch(publicRoutes, /public-reviews\/:token|params\.token/);
});
