import { extractTrustedDeviceToken } from "./trusted-device-cookie.js";

type AuthRequest = { get(name: string): string | undefined; body?: unknown; headers?: Record<string, unknown> };
export function isNativeTrustedDeviceTransport(req: AuthRequest): boolean {
  return req.get("x-pin-go-client")?.trim().toLowerCase() === "mobile" &&
    req.get("origin") === undefined && req.get("cookie") === undefined;
}
export function loginTrustedDeviceToken(req: AuthRequest): string | null {
  if (req.get("x-pin-go-client")?.trim().toLowerCase() !== "mobile") return extractTrustedDeviceToken(req);
  if (!isNativeTrustedDeviceTransport(req)) return null;
  const body = req.body;
  const value = body && typeof body === "object" && !Array.isArray(body) ?
    (body as { mobileTrustedDeviceToken?: unknown }).mobileTrustedDeviceToken : undefined;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function mobileTrustedDevicePayload(req: AuthRequest, trusted: { token: string; expiresAt: Date } | null) {
  if (!isNativeTrustedDeviceTransport(req) || !trusted) return {};
  return { mobileTrustedDeviceToken: trusted.token, mobileTrustedDeviceExpiresAt: trusted.expiresAt.toISOString() };
}

