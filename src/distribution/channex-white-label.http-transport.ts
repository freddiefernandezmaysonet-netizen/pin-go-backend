import type {
  WhiteLabelHttpTransport,
  WhiteLabelTransportRequest,
} from "./channex-white-label.adapter.js";

const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

const ALLOWED_POST_PATHS = new Set([
  "/api/v1/groups",
  "/api/v1/properties",
  "/api/v1/room_types",
  "/api/v1/rate_plans",
  "/api/v1/auth/one_time_token",
  "/api/v1/meta/airbnb/connection_link",
]);

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DIAGNOSTIC_BODY_BYTES = 16_384;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 240;
const MAX_DIAGNOSTIC_DETAIL_ENTRIES = 12;

export class WhiteLabelHttpTransportError extends Error {
  readonly retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED";

  constructor(
    readonly code: string,
    retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED",
    readonly providerStatus: number | null = null,
    readonly providerCode: string | null = null,
    readonly providerMessage: string | null = null
  ) {
    super(code);
    this.name = "WhiteLabelHttpTransportError";
    this.retryDisposition = retryDisposition;
  }
}

function apiOrigin(rawValue: string): string {
  try {
    const parsed = new URL(String(rawValue ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !ALLOWED_API_ORIGINS.has(parsed.origin)
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_API_ORIGIN_INVALID",
      "SAFE_RETRY"
    );
  }
}

function requestUrl(origin: string, request: WhiteLabelTransportRequest): URL {
  if (request.method !== "POST" || !ALLOWED_POST_PATHS.has(request.path)) {
    throw new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_REQUEST_NOT_ALLOWED",
      "SAFE_RETRY"
    );
  }
  const url = new URL(request.path, origin);
  if (url.origin !== origin || url.pathname !== request.path) {
    throw new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_REQUEST_NOT_ALLOWED",
      "SAFE_RETRY"
    );
  }
  return url;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeDiagnosticValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  let normalized = String(value).replace(/[\r\n\t]+/g, " ").trim();
  if (!normalized) return null;
  normalized = normalized
    .replace(/https?:\/\/\S+/gi, "[URL_REDACTED]")
    .replace(/\b(?:token|api[_ -]?key|authorization|password|secret)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[VALUE_REDACTED]")
    .replace(/[^\x20-\x7E]/g, "?");
  return normalized.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH) || null;
}

function sanitizeDiagnosticKey(value: string): string | null {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_.\[\]-]/g, "_")
    .slice(0, 120);
  return normalized || null;
}

function flattenDocumentedDetails(value: unknown): string | null {
  const entries: string[] = [];

  const visit = (current: unknown, path: string, depth: number) => {
    if (entries.length >= MAX_DIAGNOSTIC_DETAIL_ENTRIES || depth > 3) return;

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length && entries.length < MAX_DIAGNOSTIC_DETAIL_ENTRIES; index += 1) {
        visit(current[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }

    const object = record(current);
    if (object) {
      for (const [key, nested] of Object.entries(object)) {
        if (entries.length >= MAX_DIAGNOSTIC_DETAIL_ENTRIES) break;
        const safeKey = sanitizeDiagnosticKey(key);
        if (!safeKey) continue;
        visit(nested, path ? `${path}.${safeKey}` : safeKey, depth + 1);
      }
      return;
    }

    const safeValue = sanitizeDiagnosticValue(current);
    const safePath = sanitizeDiagnosticKey(path);
    if (safeValue && safePath) entries.push(`${safePath}=${safeValue}`);
  };

  visit(value, "", 0);
  if (!entries.length) return null;
  return entries.join("; ").slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
}

function extractProviderDiagnostic(payload: unknown): {
  providerCode: string | null;
  providerMessage: string | null;
} {
  const root = record(payload);
  if (!root) return { providerCode: null, providerMessage: null };
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const firstError = record(errors[0]);
  const error = record(root.error);
  const documentedDetails = flattenDocumentedDetails(root.details);
  const providerCode = sanitizeDiagnosticValue(
    firstError?.code ?? error?.code ?? root.code ?? firstError?.title ?? error?.title ??
      (documentedDetails ? "validation_details" : null)
  );
  const providerMessage = sanitizeDiagnosticValue(
    firstError?.detail ?? firstError?.message ?? error?.detail ?? error?.message ??
      root.message ?? root.detail ?? root.error
  ) ?? documentedDetails;
  return { providerCode, providerMessage };
}

async function readProviderDiagnostic(response: Response): Promise<{
  providerCode: string | null;
  providerMessage: string | null;
}> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_DIAGNOSTIC_BODY_BYTES) {
    return { providerCode: null, providerMessage: null };
  }
  try {
    const body = await response.text();
    if (!body || body.length > MAX_DIAGNOSTIC_BODY_BYTES) {
      return { providerCode: null, providerMessage: null };
    }
    return extractProviderDiagnostic(JSON.parse(body) as unknown);
  } catch {
    return { providerCode: null, providerMessage: null };
  }
}

async function responseFailure(response: Response): Promise<WhiteLabelHttpTransportError> {
  const diagnostic = response.status >= 400 && response.status < 500
    ? await readProviderDiagnostic(response)
    : { providerCode: null, providerMessage: null };
  if (response.status === 429) {
    return new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_RATE_LIMITED",
      "SAFE_RETRY",
      response.status,
      diagnostic.providerCode,
      diagnostic.providerMessage
    );
  }
  if (response.status >= 400 && response.status < 500) {
    console.warn("[ota-provider] request rejected", {
      providerStatus: response.status,
      providerCode: diagnostic.providerCode,
      providerMessage: diagnostic.providerMessage,
    });
    return new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_REQUEST_REJECTED",
      "SAFE_RETRY",
      response.status,
      diagnostic.providerCode,
      diagnostic.providerMessage
    );
  }
  return new WhiteLabelHttpTransportError(
    "OTA_PROVIDER_RECONCILIATION_REQUIRED",
    "RECONCILIATION_REQUIRED",
    response.status
  );
}

export function createChannexWhiteLabelHttpTransport(args: {
  apiOrigin: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): WhiteLabelHttpTransport {
  const origin = apiOrigin(args.apiOrigin);
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1_000 || args.timeoutMs > 15_000) {
    throw new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_TIMEOUT_CONFIGURATION_INVALID",
      "SAFE_RETRY"
    );
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_TRANSPORT_UNAVAILABLE",
      "SAFE_RETRY"
    );
  }

  return {
    async send(request) {
      const url = requestUrl(origin, request);
      const apiKey = String(request.headers["user-api-key"] ?? "").trim();
      if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
        throw new WhiteLabelHttpTransportError(
          "OTA_PROVIDER_CREDENTIALS_UNAVAILABLE",
          "SAFE_RETRY"
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "user-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request.body),
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          throw new WhiteLabelHttpTransportError(
            "OTA_PROVIDER_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
        if (!response.ok) throw await responseFailure(response);

        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new WhiteLabelHttpTransportError(
            "OTA_PROVIDER_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
        const body = await response.text();
        if (body.length > MAX_RESPONSE_BYTES) {
          throw new WhiteLabelHttpTransportError(
            "OTA_PROVIDER_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new WhiteLabelHttpTransportError(
            "OTA_PROVIDER_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
