// Push delivery uses the registered device lifetime, not interactive idle time.
// This does not authorize HTTP requests or renew/touch an AuthSession. All
// explicit revocations remain terminal; ordinary HTTP timeouts do not revoke push consent.
export type PushSessionBinding = {
  id: string; userId: string; organizationId: string; tokenVersion: number;
  revokedAt: Date | null; revokeReason?: string | null; authenticatedAt: Date; lastActivityAt: Date;
};

export function permitsHostPushBinding(
  session: PushSessionBinding | null,
  expected: {sessionId: string; userId: string; organizationId: string; tokenVersion: number},
  now: Date,
): boolean {
  if (!session || (session.revokedAt !== null && !['IDLE_TIMEOUT','ABSOLUTE_TIMEOUT'].includes(session.revokeReason ?? '')) || session.id !== expected.sessionId ||
      session.userId !== expected.userId || session.organizationId !== expected.organizationId ||
      session.tokenVersion !== expected.tokenVersion) return false;
  const authenticated = session.authenticatedAt.getTime(), activity = session.lastActivityAt.getTime();
  return Number.isFinite(authenticated) && Number.isFinite(activity) && Number.isFinite(now.getTime()) &&
    authenticated <= activity && activity <= now.getTime();
}
