// Selected only after successful authentication; subsequent requests use the stored policy.
export type HostSessionPolicy = "LEGACY" | "HOST_WEB_V1" | "HOST_MOBILE_V1";
const DAY = 24 * 60 * 60 * 1000;
export function isRollingHostPolicy(value: unknown): value is "HOST_WEB_V1" | "HOST_MOBILE_V1" {
  return value === "HOST_WEB_V1" || value === "HOST_MOBILE_V1";
}
export function hostIdleTimeoutMs(policy: unknown): number | null {
  return policy === "HOST_MOBILE_V1" ? 30 * DAY : policy === "HOST_WEB_V1" ? DAY : null;
}
export function hostCredentialLifetimeSeconds(policy: unknown): number | undefined {
  const idle = hostIdleTimeoutMs(policy);
  // The database enforces inactivity. Extra transport lifetime prevents a token
  // from expiring before the last accepted human activity's lease.
  return idle === null ? undefined : (idle + DAY) / 1000;
}
export function selectHostSessionPolicy(role: string, mobile: boolean, renewalCapable: boolean): HostSessionPolicy {
  if (!["ORG_ADMIN", "ADMIN", "MEMBER"].includes(role)) return "LEGACY";
  if (mobile) return renewalCapable ? "HOST_MOBILE_V1" : "LEGACY";
  return "HOST_WEB_V1";
}

export function hostCredentialNeedsRenewal(policy: unknown, expiresAtMs: number | undefined, now = Date.now()): boolean {
  const idle = hostIdleTimeoutMs(policy);
  return idle !== null && (!Number.isFinite(expiresAtMs) || (expiresAtMs ?? 0) - now <= idle + 5 * 60 * 1000);
}
