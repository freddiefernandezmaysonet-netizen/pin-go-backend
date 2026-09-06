export type OtaConnectionCenterRuntime = {
  enabled: boolean;
  reason:
    | "ENABLED"
    | "DEFAULT_OFF"
    | "INVALID_CONFIGURATION"
    | "ADAPTER_UNAVAILABLE"
    | "CONFIGURATION_INCOMPLETE";
};

export function resolveOtaConnectionCenterRuntime(
  rawValue: string | undefined
): OtaConnectionCenterRuntime {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized || normalized === "false" || normalized === "0") {
    return { enabled: false, reason: "DEFAULT_OFF" };
  }
  if (normalized === "true" || normalized === "1") {
    return { enabled: true, reason: "ENABLED" };
  }
  return { enabled: false, reason: "INVALID_CONFIGURATION" };
}
