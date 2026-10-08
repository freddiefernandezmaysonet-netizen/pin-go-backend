const SESSION_ROUTES = new Set(["/auth/me", "/auth/logout", "/auth/session/activity", "/auth/login", "/auth/mfa/verify", "/auth/mfa/resend", "/auth/forgot-password", "/auth/reset-password", "/auth/forgot-password/verify-code"]);

export function cleanerSurfaceAllowed(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0] ?? "";
  return SESSION_ROUTES.has(path) || /^\/api\/cleaner(?:\/|$)/.test(path) || /^\/cleaning\/confirm\/[^/]+(?:\/(?:confirm|decline|cancel|timing-consent|start|complete|checklist\/[^/]+))?$/.test(path);
}

export function assertCleanerIdentity(user: { id: string; orgId: string; role?: string }, staff: {
  dashboardUserId: string | null; organizationId: string; isActive: boolean;
} | null) {
  if (user.role !== "CLEANER" || !staff?.isActive || staff.dashboardUserId !== user.id || staff.organizationId !== user.orgId) {
    throw new Error("CLEANER_IDENTITY_REQUIRED");
  }
}
