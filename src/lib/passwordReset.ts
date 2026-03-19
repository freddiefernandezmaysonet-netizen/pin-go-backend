import crypto from "crypto";

export function generateResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getResetTokenExpiry(minutes = 45) {
  return new Date(Date.now() + minutes * 60 * 1000);
}