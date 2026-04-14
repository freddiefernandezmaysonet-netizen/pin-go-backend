import crypto from "crypto";

export function generateGuestToken() {
  // 32 bytes => 64 chars hex (bien fuerte)
  return crypto.randomBytes(32).toString("hex");
}

export function buildGuestLink(token: string) {
  const baseUrl =
    process.env.APP_BASE_URL ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173";

  return `${baseUrl}/guest/access/${token}`;
}
