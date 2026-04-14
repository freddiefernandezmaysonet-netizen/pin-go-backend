import crypto from "crypto";
import {
  TUYA_BASE_URL,
  TUYA_CLIENT_ID,
  TUYA_CLIENT_SECRET,
  assertTuyaEnv,
} from "./tuya.config";
import {
  buildStringToSign,
  buildTuyaSign,
} from "./tuya.sign";
import type { TuyaApiResponse } from "./tuya.types";

export type TuyaRequestOptions = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  accessToken?: string;
  signedHeaders?: Record<string, string>;
};

export async function tuyaRequest<T = unknown>(
  options: TuyaRequestOptions
): Promise<TuyaApiResponse<T>> {
  assertTuyaEnv();

  const method = options.method.toUpperCase() as TuyaRequestOptions["method"];
  const t = String(Date.now());
  const nonce = crypto.randomUUID();

  const { stringToSign, signatureHeadersValue, url } = buildStringToSign({
    method,
    path: options.path,
    query: options.query,
    body: options.body,
    signedHeaders: options.signedHeaders,
  });

  const sign = buildTuyaSign({
    clientId: TUYA_CLIENT_ID,
    secret: TUYA_CLIENT_SECRET,
    t,
    nonce,
    accessToken: options.accessToken,
    stringToSign,
  });

  const headers: Record<string, string> = {
    client_id: TUYA_CLIENT_ID,
    sign,
    sign_method: "HMAC-SHA256",
    t,
    nonce,
    lang: "en",
  };

  if (options.accessToken) {
    headers.access_token = options.accessToken;
  }

  if (signatureHeadersValue) {
    headers["Signature-Headers"] = signatureHeadersValue;
    for (const [k, v] of Object.entries(options.signedHeaders ?? {})) {
      headers[k] = v;
    }
  }

  let bodyText: string | undefined;
  if (options.body !== undefined && options.body !== null) {
    bodyText = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(`${TUYA_BASE_URL}${url}`, {
    method,
    headers,
    body: bodyText,
  });

  const text = await resp.text();

  let json: TuyaApiResponse<T>;
  try {
    json = text ? JSON.parse(text) : ({ success: false, msg: "Empty response", t: Date.now() } as TuyaApiResponse<T>);
  } catch {
    throw new Error(`TUYA_INVALID_JSON: ${text.slice(0, 500)}`);
  }

  if (!resp.ok) {
    throw new Error(
      `TUYA_HTTP_${resp.status}: ${json.msg ?? "HTTP error"}`
    );
  }

  return json;
}