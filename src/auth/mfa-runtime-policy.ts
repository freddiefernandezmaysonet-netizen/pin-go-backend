export type E3MfaMode = "OFF" | "SHADOW";

export type E3RuntimeDecision = {
  mode: E3MfaMode;
  sessionAllowed: true;
  telemetry: "MFA_OFF" | "MFA_SHADOW_FACTOR_PRESENT" | "MFA_SHADOW_NO_FACTOR" | "MFA_ENFORCE_BLOCKED" | "MFA_SHADOW_LOOKUP_FAILED";
  verifiedFactorCount: number | null;
};

export function resolveE3MfaMode(value: unknown): { mode: E3MfaMode; enforceBlocked: boolean } {
  const normalized = String(value ?? "OFF").trim().toUpperCase();
  if (!normalized || normalized === "OFF") return { mode: "OFF", enforceBlocked: false };
  if (normalized === "SHADOW") return { mode: "SHADOW", enforceBlocked: false };
  if (normalized === "ENFORCE") return { mode: "OFF", enforceBlocked: true };
  return { mode: "OFF", enforceBlocked: false };
}

export async function evaluateE3LoginRuntime(params: {
  configuredMode: unknown;
  loadVerifiedFactorCount: () => Promise<number>;
}): Promise<E3RuntimeDecision> {
  const resolved = resolveE3MfaMode(params.configuredMode);

  if (resolved.enforceBlocked) {
    return {
      mode: "OFF",
      sessionAllowed: true,
      telemetry: "MFA_ENFORCE_BLOCKED",
      verifiedFactorCount: null,
    };
  }

  if (resolved.mode === "OFF") {
    return {
      mode: "OFF",
      sessionAllowed: true,
      telemetry: "MFA_OFF",
      verifiedFactorCount: null,
    };
  }

  try {
    const rawCount = await params.loadVerifiedFactorCount();
    const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
    return {
      mode: "SHADOW",
      sessionAllowed: true,
      telemetry: count > 0 ? "MFA_SHADOW_FACTOR_PRESENT" : "MFA_SHADOW_NO_FACTOR",
      verifiedFactorCount: count,
    };
  } catch {
    return {
      mode: "SHADOW",
      sessionAllowed: true,
      telemetry: "MFA_SHADOW_LOOKUP_FAILED",
      verifiedFactorCount: null,
    };
  }
}
