import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function activeKey() {
  const version = String(process.env.MOBILE_ACCESS_KEY_VERSION ?? "").trim();
  const raw = String(process.env.MOBILE_ACCESS_KEYS ?? "").trim();
  if (!version || !raw) throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED");
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(raw) as Record<string, string>; } catch { throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED"); }
  const hex = parsed[version];
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED");
  return { version, key: Buffer.from(hex, "hex") };
}

function keyForVersion(version: string) {
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(String(process.env.MOBILE_ACCESS_KEYS ?? "")) as Record<string, string>; }
  catch { throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED"); }
  const hex = parsed[version];
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MOBILE_ACCESS_KEY_VERSION_UNAVAILABLE");
  return Buffer.from(hex, "hex");
}

export function encryptMobileAccessSecret(plain: string, aad: string) {
  if (!plain) throw new Error("MOBILE_ACCESS_SECRET_REQUIRED");
  const { version, key } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { keyVersion: version, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64") };
}

export function decryptMobileAccessSecret(value: string, keyVersion: string, aad: string) {
  const packed = Buffer.from(value, "base64");
  if (packed.length < 29) throw new Error("MOBILE_ACCESS_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv(ALGORITHM, keyForVersion(keyVersion), packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

export const encryptMobileLockData = encryptMobileAccessSecret;
export const decryptMobileLockData = decryptMobileAccessSecret;
