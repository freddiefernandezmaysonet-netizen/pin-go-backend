import crypto from "crypto";

const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Upper(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex").toUpperCase();
}

export function buildContentSha256(body?: unknown) {
  if (body === undefined || body === null) return EMPTY_BODY_SHA256;
  return sha256Hex(typeof body === "string" ? body : JSON.stringify(body));
}

export function buildQueryString(
  query?: Record<string, string | number | boolean | undefined | null>
) {
  if (!query) return "";
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return "";

  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function buildUrlWithQuery(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>
) {
  const qs = buildQueryString(query);
  return qs ? `${path}?${qs}` : path;
}

export function buildStringToSign(params: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signedHeaders?: Record<string, string>;
}) {
  const method = params.method.toUpperCase();
  const contentSha256 = buildContentSha256(params.body);

  const signedHeaders = params.signedHeaders ?? {};
  const headerKeys = Object.keys(signedHeaders).sort((a, b) => a.localeCompare(b));

  const signatureHeadersValue = headerKeys.join(":");
  const headerLines = headerKeys.map((k) => `${k}:${signedHeaders[k]}`).join("\n");

  const url = buildUrlWithQuery(params.path, params.query);

  const stringToSign = [
    method,
    contentSha256,
    headerLines, // puede ser "" y dejar línea en blanco, que es correcto
    url,
  ].join("\n");

  return {
    stringToSign,
    signatureHeadersValue,
    url,
    contentSha256,
  };
}

export function buildTuyaSign(params: {
  clientId: string;
  secret: string;
  t: string;
  nonce?: string;
  accessToken?: string;
  stringToSign: string;
}) {
  const str = [
    params.clientId,
    params.accessToken ?? "",
    params.t,
    params.nonce ?? "",
    params.stringToSign,
  ].join("");

  return hmacSha256Upper(params.secret, str);
}