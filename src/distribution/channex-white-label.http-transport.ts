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
]);

export class WhiteLabelHttpTransportError extends Error {
  readonly retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED";

  constructor(
    readonly code: string,
    retryDisposition: "SAFE_RETRY" | "RECONCILIATION_REQUIRED"
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

function responseFailure(status: number): WhiteLabelHttpTransportError {
  if (status === 429) {
    return new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_RATE_LIMITED",
      "SAFE_RETRY"
    );
  }
  if (status >= 400 && status < 500) {
    return new WhiteLabelHttpTransportError(
      "OTA_PROVIDER_REQUEST_REJECTED",
      "SAFE_RETRY"
    );
  }
  return new WhiteLabelHttpTransportError(
    "OTA_PROVIDER_RECONCILIATION_REQUIRED",
    "RECONCILIATION_REQUIRED"
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
        if (!response.ok) throw responseFailure(response.status);

        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
          throw new WhiteLabelHttpTransportError(
            "OTA_PROVIDER_RECONCILIATION_REQUIRED",
            "RECONCILIATION_REQUIRED"
          );
        }
        const body = await response.text();
        if (body.length > 1_000_000) {
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
