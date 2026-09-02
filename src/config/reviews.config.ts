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

export const REVIEW_INVITATION_DELAY_MS = 24 * 60 * 60 * 1000;
