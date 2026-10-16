// Separate native write boundary; the web Origin policy remains unchanged.
export type MobileReplyIdentity = { id: string; orgId: string; role?: string; sessionId?: string };
type Payload = { sub: string; orgId: string; tokenVersion: number; sid?: string };
type Decision = { kind: string; sessionId?: string | null; user?: { id: string; organizationId: string; role: string }; status?: number; error?: string };
export type MobileReplyAuthorizationDependencies = {
  verify(token: string): Payload;
  guard(input: { userId: string; organizationId: string; tokenVersion: number; sessionId: string; mode: "ENFORCE" }): Promise<Decision>;
};
export async function authorizeMobileReply(input: {
  enabled: boolean; authorization?: string; origin?: string; cookie?: string; identity?: MobileReplyIdentity;
}, deps: MobileReplyAuthorizationDependencies): Promise<void> {
  const deny = (status: number, code: string): never => { throw Object.assign(new Error(code), { status, code }); };
  if (!input.enabled) deny(503, "HOST_MOBILE_REPLY_DISABLED");
  if (input.origin !== undefined || input.cookie !== undefined) deny(403, "HOST_MOBILE_REPLY_TRANSPORT_FORBIDDEN");
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorization ?? "");
  if (!match) deny(401, "UNAUTHENTICATED");
  let payload: Payload;
  try { payload = deps.verify(match![1]!); } catch { return deny(401, "UNAUTHENTICATED"); }
  if (!payload.sid) deny(401, "SESSION_REAUTH_REQUIRED");
  if (!input.identity || payload.sub !== input.identity.id || payload.orgId !== input.identity.orgId || payload.sid !== input.identity.sessionId)
    deny(401, "SESSION_EXPIRED");
  const result = await deps.guard({ userId: payload.sub, organizationId: payload.orgId, tokenVersion: payload.tokenVersion, sessionId: payload.sid!, mode: "ENFORCE" });
  if (result.kind !== "ALLOW") deny(result.status ?? 503, result.error ?? "SESSION_VALIDATION_UNAVAILABLE");
  if (result.sessionId !== payload.sid || result.user?.id !== payload.sub || result.user?.organizationId !== payload.orgId)
    deny(401, "SESSION_EXPIRED");
  if (!["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"].includes(result.user?.role ?? "")) deny(403, "HOST_INBOX_FORBIDDEN");
}
