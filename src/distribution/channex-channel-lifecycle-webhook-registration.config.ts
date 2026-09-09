import { createHash } from "node:crypto";

import {
  normalizeChannexUuid,
  normalizeOtaChannelLifecycleWebhookCallbackUrl,
} from "./channex-channel-lifecycle-webhook.contract.js";

export const OTA_CHANNEL_LIFECYCLE_REGISTRATION_APPLY_CONFIRMATION =
  "APPLY_CHANNEX_STAGING_CHANNEL_LIFECYCLE_WEBHOOK";

export function buildOtaChannelLifecycleRegistrationApplyConfirmation(
  externalPropertyId: string,
  callbackUrl: string
): string {
  const normalized = normalizeChannexUuid(externalPropertyId);
  if (!normalized) {
    throw new Error("OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED");
  }
  const normalizedCallbackUrl = normalizeOtaChannelLifecycleWebhookCallbackUrl(
    callbackUrl
  );
  const callbackFingerprint = createHash("sha256")
    .update(normalizedCallbackUrl, "utf8")
    .digest("hex");
  return `${OTA_CHANNEL_LIFECYCLE_REGISTRATION_APPLY_CONFIRMATION}:${normalized}:${callbackFingerprint}`;
}

export type OtaChannelLifecycleRegistrationMode = "PLAN" | "APPLY";

export type OtaChannelLifecycleWebhookRegistrationConfig =
  | {
      enabled: false;
      mode: OtaChannelLifecycleRegistrationMode;
      reason:
        | "DEFAULT_OFF"
        | "INVALID_ENABLED_VALUE"
        | "INVALID_MODE"
        | "CONFIGURATION_INCOMPLETE"
        | "STAGING_REQUIRED"
        | "CALLBACK_ORIGIN_NOT_ALLOWED"
        | "APPLY_CONFIRMATION_REQUIRED";
    }
  | ({
      enabled: true;
      reason: "ENABLED";
      apiOrigin: string;
      apiKey: string;
      callbackUrl: string;
      callbackAllowedOrigin: string;
      externalPropertyId: string;
      webhookSecret: string;
      timeoutMs: number;
    } & (
      | { mode: "PLAN" }
      | {
          mode: "APPLY";
          applyConfirmation: string;
        }
    ));

const API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

function exactApiOrigin(value: unknown): string | null {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !API_ORIGINS.has(parsed.origin)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function secretValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[\x21-\x7E]{1,512}$/.test(normalized) ? normalized : null;
}

function callbackUrl(value: unknown): string | null {
  try {
    return normalizeOtaChannelLifecycleWebhookCallbackUrl(value);
  } catch {
    return null;
  }
}

function exactHttpsOrigin(value: unknown): string | null {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function timeout(value: unknown): number | null {
  const raw = String(value ?? "10000").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 15_000
    ? parsed
    : null;
}

export function resolveOtaChannelLifecycleWebhookRegistrationConfig(
  env: Readonly<Record<string, string | undefined>>
): OtaChannelLifecycleWebhookRegistrationConfig {
  const enabledValue = String(
    env.OTA_CHANNEL_LIFECYCLE_REGISTRATION_ENABLED ?? ""
  ).trim();

  if (!enabledValue || enabledValue === "false") {
    return { enabled: false, mode: "PLAN", reason: "DEFAULT_OFF" };
  }
  if (enabledValue !== "true") {
    return { enabled: false, mode: "PLAN", reason: "INVALID_ENABLED_VALUE" };
  }

  const modeValue = String(
    env.OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE ?? "PLAN"
  )
    .trim()
    .toUpperCase();
  if (modeValue !== "PLAN" && modeValue !== "APPLY") {
    return { enabled: false, mode: "PLAN", reason: "INVALID_MODE" };
  }
  const mode = modeValue as OtaChannelLifecycleRegistrationMode;

  const apiOrigin = exactApiOrigin(env.OTA_CONNECTION_PROVIDER_API_ORIGIN);
  const apiKey = secretValue(env.OTA_CONNECTION_API_KEY);
  const normalizedCallbackUrl = callbackUrl(
    env.OTA_CHANNEL_LIFECYCLE_CALLBACK_URL
  );
  const callbackAllowedOrigin = exactHttpsOrigin(
    env.OTA_CHANNEL_LIFECYCLE_CALLBACK_ALLOWED_ORIGIN
  );
  const externalPropertyId = normalizeChannexUuid(
    env.OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID
  );
  const webhookSecret = secretValue(env.OTA_CHANNEL_WEBHOOK_SECRET);
  const timeoutMs = timeout(env.OTA_CONNECTION_HTTP_TIMEOUT_MS);

  if (
    !apiOrigin ||
    !apiKey ||
    !normalizedCallbackUrl ||
    !callbackAllowedOrigin ||
    !externalPropertyId ||
    !webhookSecret ||
    timeoutMs === null
  ) {
    return { enabled: false, mode, reason: "CONFIGURATION_INCOMPLETE" };
  }

  if (apiOrigin !== "https://staging.channex.io") {
    return { enabled: false, mode, reason: "STAGING_REQUIRED" };
  }
  if (new URL(normalizedCallbackUrl).origin !== callbackAllowedOrigin) {
    return { enabled: false, mode, reason: "CALLBACK_ORIGIN_NOT_ALLOWED" };
  }
  const applyConfirmation =
    buildOtaChannelLifecycleRegistrationApplyConfirmation(
      externalPropertyId,
      normalizedCallbackUrl
    );
  if (
    mode === "APPLY" &&
    String(env.OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION ?? "").trim() !==
      applyConfirmation
  ) {
    return { enabled: false, mode, reason: "APPLY_CONFIRMATION_REQUIRED" };
  }

  const common = {
    enabled: true,
    reason: "ENABLED",
    apiOrigin,
    apiKey,
    callbackUrl: normalizedCallbackUrl,
    callbackAllowedOrigin,
    externalPropertyId,
    webhookSecret,
    timeoutMs,
  } as const;

  return mode === "APPLY"
    ? {
        ...common,
        mode,
        applyConfirmation,
      }
    : { ...common, mode };
}
