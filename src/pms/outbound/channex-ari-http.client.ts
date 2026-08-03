import axios from "axios";

import type { ChannexAriAttemptCompletionEvidence } from "./channex-ari-attempt-completion.policy";
import {
  CHANNEX_ARI_MAX_REQUEST_BYTES,
  assertPayloadWithinLimit,
  type ChannexAriMessageKind,
} from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_HTTP_DEFAULT_BASE_URL = "https://staging.channex.io";
export const CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS = 15_000;
export const CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS = 120_000;

export type ChannexAriHttpResponse = {
  status: number;
  data?: unknown;
  headers?: unknown;
};

export type ChannexAriHttpTransport = {
  post(
    url: string,
    data: unknown,
    config: {
      headers: Record<string, string>;
      timeout: number;
      validateStatus: (status: number) => boolean;
      maxBodyLength: number;
      maxContentLength: number;
    }
  ): Promise<ChannexAriHttpResponse>;
};

export type SendChannexAriHttpRequestInput = {
  messageKind: ChannexAriMessageKind;
  payload: unknown;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  receivedAt?: Date;
  transport?: ChannexAriHttpTransport;
};

export type SendChannexAriHttpRequestResult = {
  endpoint: "/api/v1/availability" | "/api/v1/restrictions";
  url: string;
  payloadBytes: number;
  evidence: ChannexAriAttemptCompletionEvidence;
};

type UnknownRecord = Record<string, unknown>;

const SENSITIVE_RESPONSE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "user-api-key",
  "x-api-key",
]);

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }

  return null;
}

function requireApiKey(value: unknown): string {
  const apiKey = asString(value);

  if (!apiKey) {
    throw new Error("CHANNEX_ARI_HTTP_API_KEY_REQUIRED");
  }

  if (apiKey.length > 4_096) {
    throw new Error("CHANNEX_ARI_HTTP_API_KEY_INVALID");
  }

  return apiKey;
}

function normalizeBaseUrl(value?: string): string {
  const configured =
    asString(value) ??
    asString(process.env.CHANNEX_API_BASE_URL) ??
    CHANNEX_ARI_HTTP_DEFAULT_BASE_URL;

  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("CHANNEX_ARI_HTTP_BASE_URL_INVALID");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("CHANNEX_ARI_HTTP_BASE_URL_INVALID");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CHANNEX_ARI_HTTP_BASE_URL_INVALID");
  }

  return parsed.toString().replace(/\/+$/, "");
}

function normalizeTimeoutMs(value?: number): number {
  const timeoutMs =
    value === undefined ? CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS : Number(value);

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS
  ) {
    throw new Error("CHANNEX_ARI_HTTP_TIMEOUT_INVALID");
  }

  return timeoutMs;
}

function normalizeReceivedAt(value?: Date): Date {
  const receivedAt = value ? new Date(value) : new Date();

  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error("CHANNEX_ARI_HTTP_RECEIVED_AT_INVALID");
  }

  return receivedAt;
}

function endpointForMessageKind(
  messageKind: ChannexAriMessageKind
): "/api/v1/availability" | "/api/v1/restrictions" {
  if (messageKind === "AVAILABILITY") return "/api/v1/availability";
  if (messageKind === "RATES_RESTRICTIONS") return "/api/v1/restrictions";
  throw new Error("CHANNEX_ARI_HTTP_MESSAGE_KIND_INVALID");
}

function assertPayloadShape(payload: unknown): number {
  const record = asRecord(payload);

  if (!record || !Array.isArray(record.values) || record.values.length === 0) {
    throw new Error("CHANNEX_ARI_HTTP_PAYLOAD_INVALID");
  }

  return assertPayloadWithinLimit(payload);
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;

  const getter = (headers as { get?: unknown }).get;

  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    const normalized = asString(value);
    if (normalized) return normalized;
  }

  const record = asRecord(headers);
  if (!record) return null;

  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === target) return asString(value);
  }

  return null;
}

function headerSource(headers: unknown): UnknownRecord | null {
  if (!headers) return null;

  const toJson = (headers as { toJSON?: unknown }).toJSON;

  if (typeof toJson === "function") {
    const serialized = toJson.call(headers);
    const record = asRecord(serialized);
    if (record) return record;
  }

  return asRecord(headers);
}

function serializeHeaderValue(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item)).join(", ").trim();
    return normalized || null;
  }

  if (typeof value === "object") {
    try {
      const normalized = JSON.stringify(value);
      return normalized || null;
    } catch {
      return "[unserializable]";
    }
  }

  return asString(value);
}

function sanitizeResponseHeaders(headers: unknown): Record<string, string> {
  const source = headerSource(headers);
  if (!source) return {};

  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || SENSITIVE_RESPONSE_HEADER_NAMES.has(normalizedKey)) {
      continue;
    }

    const normalizedValue = serializeHeaderValue(value);
    if (normalizedValue) sanitized[normalizedKey] = normalizedValue;
  }

  return sanitized;
}

function serializeRawResponseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "" : serialized;
  } catch {
    return "[unserializable response body]";
  }
}

function normalizeHttpStatus(value: unknown): number {
  const status = Number(value);

  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new Error("CHANNEX_ARI_HTTP_RESPONSE_STATUS_INVALID");
  }

  return status;
}

function parseRetryAfterMs(value: string | null, receivedAt: Date): number | null {
  if (!value) return null;

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Math.ceil(Number(value) * 1_000);
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0
      ? milliseconds
      : null;
  }

  const retryAt = new Date(value);
  if (Number.isNaN(retryAt.getTime())) return null;

  return Math.max(0, retryAt.getTime() - receivedAt.getTime());
}

function responseRoots(body: unknown): UnknownRecord[] {
  const root = asRecord(body);
  if (!root) return [];

  const data = asRecord(root.data);
  const attributes = asRecord(data?.attributes);
  const meta = asRecord(root.meta);

  return [root, data, attributes, meta].filter(
    (value): value is UnknownRecord => Boolean(value)
  );
}

function extractTaskId(body: unknown): string | null {
  const roots = responseRoots(body);

  return firstString(
    ...roots.flatMap((root) => [
      root.task_id,
      root.taskId,
      root.task_uuid,
      root.taskUuid,
    ]),
    asRecord(asRecord(body)?.data)?.id
  );
}

function countContainer(value: unknown): number {
  if (value == null) return 0;

  if (Array.isArray(value)) return value.length;

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  if (typeof value === "string") return value.trim() ? 1 : 0;

  const record = asRecord(value);
  return record ? Object.keys(record).length : 0;
}

// CHANNEX_ARI_BENIGN_SINGULAR_WARNING_FIX_V1

function countWarningEvidence(input: {
  key: string;
  value: unknown;
}): number {
  if (
    input.key === "warning" &&
    typeof input.value === "string" &&
    input.value.trim().toLowerCase() === "success"
  ) {
    return 0;
  }

  return countContainer(input.value);
}

function extractWarningCount(body: unknown): number {
  const counts: number[] = [];

  for (const root of responseRoots(body)) {
    for (const key of [
      "warning_count",
      "warningCount",
      "warnings",
      "warning",
      "rejected_values",
      "rejectedValues",
    ]) {
      counts.push(
        countWarningEvidence({
          key,
          value: root[key],
        })
      );
    }
  }

  return Math.max(0, ...counts);
}

function firstErrorNode(body: unknown): UnknownRecord | null {
  for (const root of responseRoots(body)) {
    if (Array.isArray(root.errors)) {
      const first = root.errors.find((value) => asRecord(value));
      if (first) return asRecord(first);
    }

    const error = asRecord(root.error);
    if (error) return error;
  }

  return null;
}

function extractPublicErrorCode(body: unknown): string | null {
  const error = firstErrorNode(body);
  const roots = responseRoots(body);

  return firstString(
    error?.code,
    ...roots.flatMap((root) => [root.error_code, root.errorCode, root.code])
  )?.slice(0, 128) ?? null;
}

function extractPublicErrorSummary(body: unknown): string | null {
  const error = firstErrorNode(body);
  const roots = responseRoots(body);
  const summary = firstString(
    error?.detail,
    error?.title,
    error?.message,
    ...roots.flatMap((root) => [
      root.error_description,
      root.errorDescription,
      root.message,
      root.detail,
    ])
  );

  return summary ? summary.slice(0, 1_000) : null;
}

function responseDataType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function buildHttpEvidence(input: {
  messageKind: ChannexAriMessageKind;
  endpoint: string;
  payloadBytes: number;
  response: ChannexAriHttpResponse;
  receivedAt: Date;
}): ChannexAriAttemptCompletionEvidence {
  const httpStatus = normalizeHttpStatus(input.response.status);
  const retryAfterHeader = getHeader(input.response.headers, "retry-after");
  const requestId = firstString(
    getHeader(input.response.headers, "x-request-id"),
    getHeader(input.response.headers, "x-correlation-id"),
    getHeader(input.response.headers, "cf-ray")
  );
  const warningCount = extractWarningCount(input.response.data);
  const responseHeaders = sanitizeResponseHeaders(input.response.headers);
  const rawResponseText = serializeRawResponseText(input.response.data);

  return {
    httpStatus,
    taskId: extractTaskId(input.response.data),
    warningCount,
    retryAfterMs: parseRetryAfterMs(retryAfterHeader, input.receivedAt),
    errorCode:
      httpStatus >= 400 || warningCount > 0
        ? extractPublicErrorCode(input.response.data)
        : null,
    errorSummary:
      httpStatus >= 400 || warningCount > 0
        ? extractPublicErrorSummary(input.response.data)
        : null,
    responseMeta: {
      endpoint: input.endpoint,
      method: "POST",
      messageKind: input.messageKind,
      payloadBytes: input.payloadBytes,
      responseDataType: responseDataType(input.response.data),
      retryAfterHeaderPresent: Boolean(retryAfterHeader),
      receivedAt: input.receivedAt.toISOString(),
      responseHeaders,
      rawResponseText,
      ...(requestId ? { requestId } : {}),
    },
  };
}

function transportCode(error: unknown): string | null {
  const code = asString(asRecord(error)?.code);
  return code ? code.slice(0, 64) : null;
}

function isTimeoutError(error: unknown): boolean {
  const code = transportCode(error)?.toUpperCase();
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;

  const message = asString(asRecord(error)?.message)?.toLowerCase();
  return Boolean(message?.includes("timeout"));
}

function errorResponse(error: unknown): ChannexAriHttpResponse | null {
  const response = asRecord(asRecord(error)?.response);
  if (!response || response.status == null) return null;

  return {
    status: Number(response.status),
    data: response.data,
    headers: response.headers,
  };
}

export async function sendChannexAriHttpRequest(
  input: SendChannexAriHttpRequestInput
): Promise<SendChannexAriHttpRequestResult> {
  const endpoint = endpointForMessageKind(input.messageKind);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const apiKey = requireApiKey(input.apiKey);
  const payloadBytes = assertPayloadShape(input.payload);
  const receivedAt = normalizeReceivedAt(input.receivedAt);
  const url = `${baseUrl}${endpoint}`;
  const transport = input.transport ?? (axios as ChannexAriHttpTransport);

  try {
    const response = await transport.post(url, input.payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "user-api-key": apiKey,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
      maxBodyLength: CHANNEX_ARI_MAX_REQUEST_BYTES,
      maxContentLength: CHANNEX_ARI_MAX_REQUEST_BYTES,
    });

    return {
      endpoint,
      url,
      payloadBytes,
      evidence: buildHttpEvidence({
        messageKind: input.messageKind,
        endpoint,
        payloadBytes,
        response,
        receivedAt,
      }),
    };
  } catch (error) {
    const response = errorResponse(error);

    if (response) {
      return {
        endpoint,
        url,
        payloadBytes,
        evidence: buildHttpEvidence({
          messageKind: input.messageKind,
          endpoint,
          payloadBytes,
          response,
          receivedAt,
        }),
      };
    }

    const timedOut = isTimeoutError(error);
    const code = transportCode(error);

    return {
      endpoint,
      url,
      payloadBytes,
      evidence: {
        httpStatus: null,
        networkError: !timedOut,
        timedOut,
        taskId: null,
        warningCount: 0,
        retryAfterMs: null,
        responseMeta: {
          endpoint,
          method: "POST",
          messageKind: input.messageKind,
          payloadBytes,
          transportFailure: true,
          ...(code ? { transportCode: code } : {}),
        },
      },
    };
  }
}
