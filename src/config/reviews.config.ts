export function reviewsE1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PINGO_REVIEWS_E1_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function reviewInvitationDispatcherEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return reviewsE1Enabled(env) &&
    String(env.PINGO_REVIEW_INVITATION_DISPATCH_ENABLED ?? "false")
      .trim()
      .toLowerCase() === "true";
}

export function reviewInvitationEligibleAfter(
  env: NodeJS.ProcessEnv = process.env
): Date {
  const raw = String(
    env.PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER ?? ""
  ).trim();

  if (!raw) {
    throw new Error(
      "PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER_REQUIRED"
    );
  }

  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    throw new Error(
      "PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER_TIMEZONE_REQUIRED"
    );
  }

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)
  ) {
    throw new Error(
      "PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER_INVALID"
    );
  }

  const eligibleAfter = new Date(raw);
  if (Number.isNaN(eligibleAfter.getTime())) {
    throw new Error(
      "PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER_INVALID"
    );
  }

  return eligibleAfter;
}

export const REVIEW_INVITATION_DELAY_MS = 24 * 60 * 60 * 1000;
