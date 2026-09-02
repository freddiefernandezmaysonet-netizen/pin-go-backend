import crypto from "node:crypto";

const KEY_ENV = "REVIEW_TOKEN_ENC_KEY_BASE64";
const KEYRING_ENV = "REVIEW_TOKEN_ENC_KEYRING_JSON";
const ACTIVE_KID_ENV = "REVIEW_TOKEN_ENC_ACTIVE_KID";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function decodeKey(encoded: string, label: string): Buffer {
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error(`${label} must decode to exactly 32 bytes`);
  return value;
}

function keyring(env: NodeJS.ProcessEnv = process.env): { activeKid: string; keys: Map<string, Buffer> } {
  const serialized = String(env[KEYRING_ENV] ?? "").trim();
  if (serialized) {
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); }
    catch { throw new Error(`${KEYRING_ENV} must be valid JSON`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${KEYRING_ENV} must be a JSON object`);
    const keys = new Map<string, Buffer>();
    for (const [kid, encoded] of Object.entries(parsed)) {
      if (!KEY_ID_PATTERN.test(kid) || typeof encoded !== "string" || !encoded.trim()) throw new Error(`${KEYRING_ENV} contains an invalid key entry`);
      keys.set(kid, decodeKey(encoded.trim(), `${KEYRING_ENV}.${kid}`));
    }
    const activeKid = String(env[ACTIVE_KID_ENV] ?? "").trim();
    if (!KEY_ID_PATTERN.test(activeKid) || !keys.has(activeKid)) throw new Error(`${ACTIVE_KID_ENV} must identify a key in ${KEYRING_ENV}`);
    return { activeKid, keys };
  }

  const encoded = String(env[KEY_ENV] ?? "").trim();
  if (!encoded) throw new Error(`Missing ${KEY_ENV} or ${KEYRING_ENV}`);
  return { activeKid: "v1", keys: new Map([["v1", decodeKey(encoded, KEY_ENV)]]) };
}

export function assertReviewTokenEncryptionConfigured(): void { keyring(); }

export function encryptReviewToken(token: string): string {
  if (!token.trim()) throw new Error("Cannot encrypt an empty review token");
  const configuration = keyring();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", configuration.keys.get(configuration.activeKid)!, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${configuration.activeKid}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function decryptReviewToken(payload: string): string {
  const separator = payload.indexOf(".");
  const kid = separator > 0 ? payload.slice(0, separator) : "v1";
  const encoded = separator > 0 ? payload.slice(separator + 1) : payload;
  if (!KEY_ID_PATTERN.test(kid) || !encoded) throw new Error("Invalid encrypted review token envelope");
  const configuration = keyring();
  const encryptionKey = configuration.keys.get(kid);
  if (!encryptionKey) throw new Error(`Unknown review token encryption key id: ${kid}`);
  const value = Buffer.from(encoded, separator > 0 ? "base64url" : "base64");
  if (value.length <= 28) throw new Error("Invalid encrypted review token payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}
