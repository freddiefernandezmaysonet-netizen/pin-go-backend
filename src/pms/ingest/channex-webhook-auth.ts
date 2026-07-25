import crypto from "crypto";

export const CHANNEX_WEBHOOK_SECRET_HEADER =
  "x-pin-go-webhook-secret";

export function generateChannexWebhookSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeHeaderValue(value: unknown) {
  if (Array.isArray(value)) {
    return String(value[0] ?? "").trim();
  }

  return String(value ?? "").trim();
}

export function readChannexWebhookSecret(
  headers: Record<string, unknown>
) {
  return normalizeHeaderValue(
    headers[CHANNEX_WEBHOOK_SECRET_HEADER] ??
      headers[CHANNEX_WEBHOOK_SECRET_HEADER.toLowerCase()]
  );
}

export function verifyChannexWebhookSecret(args: {
  expectedSecret: string | null | undefined;
  headers: Record<string, unknown>;
}) {
  const expected = String(args.expectedSecret ?? "").trim();
  const received = readChannexWebhookSecret(args.headers);

  if (!expected || !received) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
