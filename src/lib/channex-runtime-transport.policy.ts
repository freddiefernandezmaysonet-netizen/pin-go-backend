export const CHANNEX_PRODUCTION_API_ORIGIN = "https://app.channex.io";
export const CHANNEX_STAGING_API_ORIGIN = "https://staging.channex.io";

type ChannexRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ChannexRuntimeTransport = {
  apiKey: string;
  apiOrigin: string;
  environment: "PRODUCTION" | "NON_PRODUCTION";
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isProductionRuntime(
  env: ChannexRuntimeEnvironment = process.env
): boolean {
  return normalizedText(env.NODE_ENV).toLowerCase() === "production";
}

function exactOrigin(value: unknown): string | null {
  const configured = normalizedText(value);
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  return parsed.origin;
}

function requireApiKey(value: unknown, errorCode: string): string {
  const apiKey = normalizedText(value);
  if (!apiKey || apiKey.length > 4_096 || !/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error(errorCode);
  }
  return apiKey;
}

export function resolveChannexRuntimeTransport(args?: {
  env?: ChannexRuntimeEnvironment;
  nonProductionApiKey?: string | null;
  nonProductionApiOrigin?: string | null;
  nonProductionMissingApiKeyError?: string;
  nonProductionInvalidOriginError?: string;
}): ChannexRuntimeTransport {
  const env = args?.env ?? process.env;

  if (isProductionRuntime(env)) {
    const apiKey = requireApiKey(
      env.OTA_CONNECTION_API_KEY,
      "CHANNEX_PRODUCTION_OTA_API_KEY_REQUIRED"
    );
    const apiOrigin = exactOrigin(env.OTA_CONNECTION_PROVIDER_API_ORIGIN);

    if (apiOrigin !== CHANNEX_PRODUCTION_API_ORIGIN) {
      throw new Error("CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED");
    }

    return {
      apiKey,
      apiOrigin,
      environment: "PRODUCTION",
    };
  }

  const apiKey = requireApiKey(
    args?.nonProductionApiKey ?? env.CHANNEX_API_KEY,
    args?.nonProductionMissingApiKeyError ?? "CHANNEX_API_KEY_MISSING"
  );
  const apiOrigin = exactOrigin(
    args?.nonProductionApiOrigin ??
      env.CHANNEX_API_BASE_URL ??
      CHANNEX_STAGING_API_ORIGIN
  );

  if (!apiOrigin) {
    throw new Error(
      args?.nonProductionInvalidOriginError ?? "CHANNEX_API_ORIGIN_INVALID"
    );
  }

  return {
    apiKey,
    apiOrigin,
    environment: "NON_PRODUCTION",
  };
}
