import { hashOpaqueToken } from "./mfa-core.js";
import { resolveMfaEmailDeliveryMode } from "./mfa-email-otp-delivery.js";

export type E6RuntimeMode = "OFF" | "SHADOW" | "CANARY";

export type E6RuntimeResolution = {
  mode: E6RuntimeMode;
  enforceBlocked: boolean;
  source: "DEFAULT" | "CONFIGURED" | "INVALID";
};

export type E6EffectiveMode = {
  mode: "OFF" | "SHADOW" | "CANARY";
  canaryReady: boolean;
  canarySelected: boolean;
  reason:
    | "MFA_OFF"
    | "MFA_SHADOW"
    | "CANARY_ACTIVE"
    | "CANARY_USER_NOT_SELECTED"
    | "CANARY_ALLOWLIST_EMPTY"
    | "CANARY_PEPPER_MISSING"
    | "CANARY_DELIVERY_NOT_RESEND"
    | "ENFORCE_BLOCKED"
    | "INVALID_MODE";
};

export type E6Environment = {
  PINGO_MFA_MODE?: string | undefined;
  PINGO_MFA_CANARY_USER_IDS?: string | undefined;
  PINGO_MFA_OTP_PEPPER?: string | undefined;
  PINGO_MFA_EMAIL_DELIVERY?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
};

export type TrustedDeviceLookupClient = {
  trustedDevice: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    update(args: unknown): Promise<unknown>;
  };
};

export function resolveE6RuntimeMode(value: unknown): E6RuntimeResolution {
  const normalized = String(value ?? "").trim().toUpperCase();

  if (!normalized || normalized === "OFF") {
    return {
      mode: "OFF",
      enforceBlocked: false,
      source: normalized ? "CONFIGURED" : "DEFAULT",
    };
  }

  if (normalized === "SHADOW") {
    return { mode: "SHADOW", enforceBlocked: false, source: "CONFIGURED" };
  }

  if (normalized === "CANARY") {
    return { mode: "CANARY", enforceBlocked: false, source: "CONFIGURED" };
  }

  if (normalized === "ENFORCE") {
    return { mode: "OFF", enforceBlocked: true, source: "CONFIGURED" };
  }

  return { mode: "OFF", enforceBlocked: false, source: "INVALID" };
}

export function parseCanaryUserIds(value: unknown): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function evaluateE6EffectiveMode(
  userId: string,
  env: E6Environment
): E6EffectiveMode {
  const runtime = resolveE6RuntimeMode(env.PINGO_MFA_MODE);

  if (runtime.enforceBlocked) {
    return {
      mode: "OFF",
      canaryReady: false,
      canarySelected: false,
      reason: "ENFORCE_BLOCKED",
    };
  }

  if (runtime.source === "INVALID") {
    return {
      mode: "OFF",
      canaryReady: false,
      canarySelected: false,
      reason: "INVALID_MODE",
    };
  }

  if (runtime.mode === "OFF") {
    return {
      mode: "OFF",
      canaryReady: false,
      canarySelected: false,
      reason: "MFA_OFF",
    };
  }

  if (runtime.mode === "SHADOW") {
    return {
      mode: "SHADOW",
      canaryReady: false,
      canarySelected: false,
      reason: "MFA_SHADOW",
    };
  }

  const canaryIds = parseCanaryUserIds(env.PINGO_MFA_CANARY_USER_IDS);
  if (canaryIds.size === 0) {
    return {
      mode: "SHADOW",
      canaryReady: false,
      canarySelected: false,
      reason: "CANARY_ALLOWLIST_EMPTY",
    };
  }

  const selected = canaryIds.has(String(userId ?? "").trim());
  if (!selected) {
    return {
      mode: "SHADOW",
      canaryReady: true,
      canarySelected: false,
      reason: "CANARY_USER_NOT_SELECTED",
    };
  }

  if (String(env.PINGO_MFA_OTP_PEPPER ?? "").trim().length < 32) {
    return {
      mode: "SHADOW",
      canaryReady: false,
      canarySelected: true,
      reason: "CANARY_PEPPER_MISSING",
    };
  }

  if (resolveMfaEmailDeliveryMode(env) !== "RESEND") {
    return {
      mode: "SHADOW",
      canaryReady: false,
      canarySelected: true,
      reason: "CANARY_DELIVERY_NOT_RESEND",
    };
  }

  return {
    mode: "CANARY",
    canaryReady: true,
    canarySelected: true,
    reason: "CANARY_ACTIVE",
  };
}

export async function findValidE6TrustedDevice(
  client: TrustedDeviceLookupClient,
  input: {
    userId: string;
    token?: string | null;
    now?: Date;
  }
): Promise<{ id: string } | null> {
  const token = String(input.token ?? "").trim();
  if (!token) return null;

  const now = input.now ?? new Date();
  const row = await client.trustedDevice.findFirst({
    where: {
      userId: input.userId,
      tokenHash: hashOpaqueToken(token),
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });

  if (!row) return null;

  await client.trustedDevice.update({
    where: { id: row.id },
    data: { lastUsedAt: now },
  });

  return row;
}
