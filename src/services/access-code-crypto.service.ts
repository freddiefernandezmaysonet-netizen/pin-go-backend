import crypto from "crypto";

const ACCESS_CODE_KEY_ENV =
  "ACCESS_CODE_ENC_KEY_BASE64";

function getAccessCodeEncryptionKey(): Buffer {
  const encodedKey = String(
    process.env[ACCESS_CODE_KEY_ENV] ?? ""
  ).trim();

  if (!encodedKey) {
    throw new Error(
      `Missing ${ACCESS_CODE_KEY_ENV}`
    );
  }

  const key = Buffer.from(
    encodedKey,
    "base64"
  );

  if (key.length !== 32) {
    throw new Error(
      `${ACCESS_CODE_KEY_ENV} must decode to exactly 32 bytes`
    );
  }

  return key;
}

export function assertAccessCodeEncryptionConfigured(): void {
  getAccessCodeEncryptionKey();
}

export function hashAccessCode(
  plainCode: string
): string {
  return crypto
    .createHash("sha256")
    .update(String(plainCode))
    .digest("hex");
}

export function encryptAccessCode(
  plainCode: string
): string {
  const code = String(plainCode).trim();

  if (!code) {
    throw new Error(
      "Cannot encrypt an empty access code"
    );
  }

  const key = getAccessCodeEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(code, "utf8"),
    cipher.final(),
  ]);

  const authenticationTag =
    cipher.getAuthTag();

  return Buffer.concat([
    iv,
    authenticationTag,
    ciphertext,
  ]).toString("base64");
}

export function decryptAccessCode(
  encryptedCode: string
): string {
  const payload = Buffer.from(
    String(encryptedCode),
    "base64"
  );

  if (payload.length <= 28) {
    throw new Error(
      "Invalid encrypted access code payload"
    );
  }

  const iv = payload.subarray(0, 12);
  const authenticationTag =
    payload.subarray(12, 28);
  const ciphertext =
    payload.subarray(28);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getAccessCodeEncryptionKey(),
    iv
  );

  decipher.setAuthTag(
    authenticationTag
  );

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}