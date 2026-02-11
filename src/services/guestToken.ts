import crypto from "crypto";

export function generateGuestToken() {
  // 32 bytes => 64 chars hex (bien fuerte)
  return crypto.randomBytes(32).toString("hex");
}
