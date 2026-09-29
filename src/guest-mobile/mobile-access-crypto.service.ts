import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyring() {
  const version = String(process.env.MOBILE_ACCESS_KEY_VERSION ?? "").trim();
  const raw = String(process.env.MOBILE_ACCESS_KEYS ?? "").trim();
  if (!version || !raw) throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED");
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(raw) as Record<string, string>; }
  catch { throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED"); }
  const hex = parsed[version];
  if (!/^[0-9a-fA-F]{64}$/.test(hex ?? "")) throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED");
  return { version, key: Buffer.from(hex, "hex") };
}

export function encryptMobileLockData(plain: string, aad: string) {
  if (!plain) throw new Error("MOBILE_ACCESS_LOCK_DATA_REQUIRED");
  const { version, key } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyVersion: version, ciphertext: Buffer.concat([iv, tag, ciphertext]).toString("base64") };
}

export function decryptMobileLockData(value: string, keyVersion: string, aad: string) {
  const raw = String(process.env.MOBILE_ACCESS_KEYS ?? "").trim();
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(raw) as Record<string, string>; }
  catch { throw new Error("MOBILE_ACCESS_CRYPTO_NOT_CONFIGURED"); }
  const hex = parsed[keyVersion];
  if (!/^[0-9a-fA-F]{64}$/.test(hex ?? "")) throw new Error("MOBILE_ACCESS_KEY_VERSION_UNAVAILABLE");
  const packed = Buffer.from(value, "base64");
  if (packed.length < 29) throw new Error("MOBILE_ACCESS_CIPHERTEXT_INVALID");
  const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), ciphertext = packed.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(hex, "hex"), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
