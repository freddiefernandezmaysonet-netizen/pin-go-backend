import assert from "node:assert/strict";
import test from "node:test";
import {
  BrandPolicyError,
  deriveAccessibleBrandTextColor,
  evaluateBrandPublicationReadiness,
  isBrandDomainTransitionAllowed,
  isBrandManagerRole,
  isBrandProfileTransitionAllowed,
  isBrandReviewerRole,
  isBrandRevisionTransitionAllowed,
  requireBrandDomainTransition,
  requireBrandManagerRole,
  requireBrandProfileTransition,
  requireBrandPublicationReadiness,
  requireBrandReviewAuthorization,
  requireBrandRevisionTransition,
  type BrandPublicationReadinessInput,
} from "./brand-policy.js";

function readyPublicationInput(): BrandPublicationReadinessInput {
  return {
    actorRole: "PLATFORM_ADMIN",
    profileId: "brand-profile-a",
    profileExperienceType: "ENTERPRISE_BRANDED",
    profileStatus: "DRAFT",
    revisionProfileId: "brand-profile-a",
    revisionApprovalStatus: "APPROVED",
    domainProfileId: "brand-profile-a",
    domainStatus: "ACTIVE",
    displayName: "Casa Azul Management",
    logoUrl: "https://cdn.example.com/brands/casa-azul-logo.png",
    faviconUrl: "https://cdn.example.com/brands/casa-azul-favicon.png",
    primaryColor: "#155EEF",
  };
}

function failedCheckCodes(
  input: BrandPublicationReadinessInput
): string[] {
  return evaluateBrandPublicationReadiness(input).checks
    .filter((check) => !check.passed)
    .map((check) => check.code);
}

test("only PLATFORM_ADMIN can manage branding", () => {
  assert.equal(isBrandManagerRole("PLATFORM_ADMIN"), true);

  for (const role of ["ADMIN", "ORG_ADMIN", "MEMBER", null] as const) {
    assert.equal(isBrandManagerRole(role), false);
    assert.throws(
      () => requireBrandManagerRole(role),
      (error) =>
        error instanceof BrandPolicyError &&
        error.code === "BRAND_MANAGER_REQUIRED"
    );
  }
});

test("only ADMIN and ORG_ADMIN can review a brand", () => {
  assert.equal(isBrandReviewerRole("ADMIN"), true);
  assert.equal(isBrandReviewerRole("ORG_ADMIN"), true);
  assert.equal(isBrandReviewerRole("PLATFORM_ADMIN"), false);
  assert.equal(isBrandReviewerRole("MEMBER"), false);
});

test("brand reviewer must belong to the branded organization", () => {
  assert.doesNotThrow(() =>
    requireBrandReviewAuthorization({
      role: "ORG_ADMIN",
      actorOrganizationId: "organization-a",
      brandOrganizationId: "organization-a",
    })
  );

  assert.throws(
    () =>
      requireBrandReviewAuthorization({
        role: "ORG_ADMIN",
        actorOrganizationId: "organization-b",
        brandOrganizationId: "organization-a",
      }),
    (error) =>
      error instanceof BrandPolicyError &&
      error.code === "BRAND_REVIEW_ORGANIZATION_MISMATCH"
  );

  assert.throws(
    () =>
      requireBrandReviewAuthorization({
        role: "PLATFORM_ADMIN",
        actorOrganizationId: "organization-a",
        brandOrganizationId: "organization-a",
      }),
    (error) =>
      error instanceof BrandPolicyError &&
      error.code === "BRAND_REVIEWER_REQUIRED"
  );
});

test("brand profile transitions do not return an active profile to draft", () => {
  assert.equal(isBrandProfileTransitionAllowed("DRAFT", "ACTIVE"), true);
  assert.equal(isBrandProfileTransitionAllowed("ACTIVE", "SUSPENDED"), true);
  assert.equal(isBrandProfileTransitionAllowed("SUSPENDED", "ACTIVE"), true);
  assert.equal(isBrandProfileTransitionAllowed("ACTIVE", "DRAFT"), false);
  assert.equal(isBrandProfileTransitionAllowed("SUSPENDED", "DRAFT"), false);

  assert.throws(
    () => requireBrandProfileTransition("ACTIVE", "DRAFT"),
    (error) =>
      error instanceof BrandPolicyError &&
      error.code === "BRAND_PROFILE_TRANSITION_INVALID"
  );
});

test("brand revision approval follows the immutable workflow", () => {
  assert.equal(
    isBrandRevisionTransitionAllowed("DRAFT", "PENDING_APPROVAL"),
    true
  );
  assert.equal(
    isBrandRevisionTransitionAllowed("PENDING_APPROVAL", "APPROVED"),
    true
  );
  assert.equal(
    isBrandRevisionTransitionAllowed("PENDING_APPROVAL", "REJECTED"),
    true
  );
  assert.equal(isBrandRevisionTransitionAllowed("DRAFT", "APPROVED"), false);
  assert.equal(
    isBrandRevisionTransitionAllowed("APPROVED", "PENDING_APPROVAL"),
    false
  );
  assert.equal(
    isBrandRevisionTransitionAllowed("REJECTED", "PENDING_APPROVAL"),
    false
  );

  assert.throws(
    () => requireBrandRevisionTransition("DRAFT", "APPROVED"),
    (error) =>
      error instanceof BrandPolicyError &&
      error.code === "BRAND_REVISION_TRANSITION_INVALID"
  );
});

test("domain must pass through verification before activation", () => {
  assert.equal(
    isBrandDomainTransitionAllowed(
      "PENDING_CONFIGURATION",
      "PENDING_DNS"
    ),
    true
  );
  assert.equal(
    isBrandDomainTransitionAllowed("PENDING_DNS", "VERIFYING"),
    true
  );
  assert.equal(isBrandDomainTransitionAllowed("VERIFYING", "ACTIVE"), true);
  assert.equal(isBrandDomainTransitionAllowed("ACTIVE", "RETIRED"), true);
  assert.equal(isBrandDomainTransitionAllowed("RETIRED", "VERIFYING"), true);
  assert.equal(isBrandDomainTransitionAllowed("PENDING_DNS", "ACTIVE"), false);
  assert.equal(isBrandDomainTransitionAllowed("RETIRED", "ACTIVE"), false);
  assert.equal(
    isBrandDomainTransitionAllowed("ACTIVE", "PENDING_DNS"),
    false
  );

  assert.throws(
    () => requireBrandDomainTransition("PENDING_DNS", "ACTIVE"),
    (error) =>
      error instanceof BrandPolicyError &&
      error.code === "BRAND_DOMAIN_TRANSITION_INVALID"
  );
});

test("accessible foreground is derived from the primary color", () => {
  assert.equal(deriveAccessibleBrandTextColor("#000000"), "#FFFFFF");
  assert.equal(deriveAccessibleBrandTextColor("#FFFFFF"), "#000000");
  assert.equal(deriveAccessibleBrandTextColor("#ffffff"), "#000000");
  assert.equal(deriveAccessibleBrandTextColor("155EEF"), null);
  assert.equal(deriveAccessibleBrandTextColor("#FFFF"), null);
});

test("complete approved brand is ready for publication", () => {
  const result = evaluateBrandPublicationReadiness(
    readyPublicationInput()
  );

  assert.equal(result.ready, true);
  assert.ok(result.onPrimaryColor);
  assert.equal(result.checks.every((check) => check.passed), true);
  assert.doesNotThrow(() =>
    requireBrandPublicationReadiness(readyPublicationInput())
  );
});

test("publication requires PLATFORM_ADMIN and an enterprise profile", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      actorRole: "ORG_ADMIN",
      profileExperienceType: "STANDARD",
    }),
    ["PLATFORM_ADMIN_ACTOR", "ENTERPRISE_BRANDED_PROFILE"]
  );
});

test("suspended profile cannot be bypassed by publishing a revision", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      profileStatus: "SUSPENDED",
    }),
    ["PROFILE_NOT_SUSPENDED"]
  );
});

test("revision and domain must belong to the selected profile", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      revisionProfileId: "brand-profile-b",
      domainProfileId: "brand-profile-c",
    }),
    ["REVISION_BELONGS_TO_PROFILE", "DOMAIN_BELONGS_TO_PROFILE"]
  );
});

test("revision must be approved and domain must be active", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      revisionApprovalStatus: "PENDING_APPROVAL",
      domainStatus: "VERIFYING",
    }),
    ["REVISION_APPROVED", "DOMAIN_ACTIVE"]
  );
});

test("publication rejects invalid name and insecure asset URLs", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      displayName: " ",
      logoUrl: "http://cdn.example.com/logo.png",
      faviconUrl: "https://user:password@cdn.example.com/favicon.png",
    }),
    ["DISPLAY_NAME_VALID", "LOGO_URL_SECURE", "FAVICON_URL_SECURE"]
  );
});

test("publication rejects invalid primary color", () => {
  assert.deepEqual(
    failedCheckCodes({
      ...readyPublicationInput(),
      primaryColor: "blue",
    }),
    ["PRIMARY_COLOR_VALID", "PRIMARY_COLOR_CONTRAST"]
  );
});

test("publication error reports every failed check", () => {
  assert.throws(
    () =>
      requireBrandPublicationReadiness({
        ...readyPublicationInput(),
        actorRole: "MEMBER",
        domainStatus: "PENDING_DNS",
      }),
    (error) => {
      assert.ok(error instanceof BrandPolicyError);
      assert.equal(error.code, "BRAND_PUBLICATION_NOT_READY");
      assert.deepEqual(error.context.failedChecks, [
        "PLATFORM_ADMIN_ACTOR",
        "DOMAIN_ACTIVE",
      ]);
      return true;
    }
  );
});
