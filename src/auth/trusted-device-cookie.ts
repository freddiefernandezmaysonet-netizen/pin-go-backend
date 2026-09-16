import { TRUSTED_DEVICE_TTL_MS } from "./session-security.policy.js";

export const TRUSTED_DEVICE_COOKIE_NAME = "pingo_trusted_device";

export function buildTrustedDeviceCookie(token: string): string {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("TRUSTED_DEVICE_TOKEN_REQUIRED");

  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${TRUSTED_DEVICE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${isProd ? "None" : "Lax"}`,
    `Max-Age=${Math.floor(TRUSTED_DEVICE_TTL_MS / 1000)}`,
  ];

  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearTrustedDeviceCookie(): string {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${TRUSTED_DEVICE_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${isProd ? "None" : "Lax"}`,
    "Max-Age=0",
  ];

  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

export function extractTrustedDeviceToken(req: { headers?: Record<string, unknown> }): string | null {
  const cookieHeader = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key !== TRUSTED_DEVICE_COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }

  return null;
}
