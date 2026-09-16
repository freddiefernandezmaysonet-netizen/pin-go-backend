export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionSecurityState = {
  authenticatedAt: Date;
  lastActivityAt: Date;
};

export type SessionSecurityDecision =
  | { valid: true; reason: "ACTIVE" }
  | { valid: false; reason: "IDLE_TIMEOUT" | "ABSOLUTE_TIMEOUT" | "INVALID_TIMELINE" };

export function evaluateSessionSecurity(
  state: SessionSecurityState,
  now = new Date()
): SessionSecurityDecision {
  const authenticatedAt = state.authenticatedAt.getTime();
  const lastActivityAt = state.lastActivityAt.getTime();
  const current = now.getTime();

  if (
    !Number.isFinite(authenticatedAt) ||
    !Number.isFinite(lastActivityAt) ||
    !Number.isFinite(current) ||
    lastActivityAt < authenticatedAt ||
    current < lastActivityAt
  ) {
    return { valid: false, reason: "INVALID_TIMELINE" };
  }

  if (current - authenticatedAt >= SESSION_ABSOLUTE_TIMEOUT_MS) {
    return { valid: false, reason: "ABSOLUTE_TIMEOUT" };
  }

  if (current - lastActivityAt >= SESSION_IDLE_TIMEOUT_MS) {
    return { valid: false, reason: "IDLE_TIMEOUT" };
  }

  return { valid: true, reason: "ACTIVE" };
}

export function trustedDeviceExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + TRUSTED_DEVICE_TTL_MS);
}

export function isTrustedDeviceValid(expiresAt: Date, revokedAt: Date | null | undefined, now = new Date()): boolean {
  if (revokedAt) return false;
  return expiresAt.getTime() > now.getTime();
}
