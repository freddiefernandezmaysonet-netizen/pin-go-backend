// Push delivery uses the registered device lifetime, not interactive idle time.
// This does not authorize HTTP requests or renew/touch an AuthSession. All
// explicit revocations (including lazy timeout revocations) remain terminal.
export type PushSessionBinding = {
  id: string; userId: string; organizationId: string; tokenVersion: number;
  revokedAt: Date | null; authenticatedAt: Date; lastActivityAt: Date;
};

export function permitsHostPushBinding(
  session: PushSessionBinding | null,
  expected: {sessionId: string; userId: string; organizationId: string; tokenVersion: number},
  now: Date,
): boolean {
  if (!session || session.revokedAt !== null || session.id !== expected.sessionId ||
      session.userId !== expected.userId || session.organizationId !== expected.organizationId ||
      session.tokenVersion !== expected.tokenVersion) return false;
  const authenticated = session.authenticatedAt.getTime(), activity = session.lastActivityAt.getTime();
  return Number.isFinite(authenticated) && Number.isFinite(activity) && Number.isFinite(now.getTime()) &&
    authenticated <= activity && activity <= now.getTime();
}
