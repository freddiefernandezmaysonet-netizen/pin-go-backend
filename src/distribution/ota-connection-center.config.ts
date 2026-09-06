import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import { resolveOtaConnectionCenterRuntime } from "./ota-connection-runtime.policy.js";

export type OtaConnectionCenterProviderConfig = {
  apiOrigin: string;
  apiKey: string;
  iframeBaseUrl: string;
  allowedLaunchOrigins: readonly string[];
  channelFilterByProvider: Readonly<
    Partial<Record<ConnectionCenterProvider, string>>
  >;
  defaultCurrency: string;
  timeoutMs: number;
};

export type OtaConnectionCenterConfig =
  | {
      enabled: false;
      reason: "DEFAULT_OFF" | "INVALID_CONFIGURATION" | "CONFIGURATION_INCOMPLETE";
    }
  | { enabled: true; reason: "ENABLED"; provider: OtaConnectionCenterProviderConfig };

const API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

const IFRAME_URLS = new Set([
  "https://app.channex.io/channels",
  "https://staging.channex.io/channels",
]);

function exactUrl(rawValue: string | undefined, allowed: ReadonlySet<string>): URL | null {
  try {
    const parsed = new URL(String(rawValue ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !allowed.has(parsed.toString().replace(/\/$/, ""))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function channelFilter(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(normalized) ? normalized : null;
}

export function resolveOtaConnectionCenterConfig(
  env: Readonly<Record<string, string | undefined>>
): OtaConnectionCenterConfig {
  const runtime = resolveOtaConnectionCenterRuntime(env.OTA_CONNECTION_CENTER_ENABLED);
  if (!runtime.enabled) {
    return {
      enabled: false,
      reason:
        runtime.reason === "INVALID_CONFIGURATION"
          ? "INVALID_CONFIGURATION"
          : "DEFAULT_OFF",
    };
  }

  const apiUrl = exactUrl(env.OTA_CONNECTION_PROVIDER_API_ORIGIN, API_ORIGINS);
  const iframeUrl = exactUrl(env.OTA_CONNECTION_IFRAME_BASE_URL, IFRAME_URLS);
  const apiKey = String(env.OTA_CONNECTION_API_KEY ?? "").trim();
  const currency = String(env.OTA_CONNECTION_DEFAULT_CURRENCY ?? "").trim().toUpperCase();
  const airbnbFilter = channelFilter(env.OTA_CONNECTION_AIRBNB_FILTER);
  const bookingFilter = channelFilter(env.OTA_CONNECTION_BOOKING_FILTER);
  const timeoutRaw = String(env.OTA_CONNECTION_HTTP_TIMEOUT_MS ?? "10000").trim();
  const timeoutMs = Number(timeoutRaw);

  if (
    !apiUrl ||
    !iframeUrl ||
    apiUrl.origin !== iframeUrl.origin ||
    !/^[\x21-\x7E]{1,512}$/.test(apiKey) ||
    !/^[A-Z]{3}$/.test(currency) ||
    !airbnbFilter ||
    !bookingFilter ||
    !/^\d+$/.test(timeoutRaw) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 15_000
  ) {
    return { enabled: false, reason: "CONFIGURATION_INCOMPLETE" };
  }

  return {
    enabled: true,
    reason: "ENABLED",
    provider: {
      apiOrigin: apiUrl.origin,
      apiKey,
      iframeBaseUrl: iframeUrl.toString(),
      allowedLaunchOrigins: [iframeUrl.origin],
      channelFilterByProvider: {
        AIRBNB: airbnbFilter,
        BOOKING_COM: bookingFilter,
      },
      defaultCurrency: currency,
      timeoutMs,
    },
  };
}
