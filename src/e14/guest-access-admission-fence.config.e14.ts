export const GUEST_ACCESS_ADMISSION_E14_ENV =
  "GUEST_JOURNEY_E14_ACCESS_ADMISSION_ENABLED";

export type GuestAccessAdmissionE14Config = {
  enabled: boolean;
  valid: boolean;
  source: "DEFAULT_OFF" | "ENV" | "INVALID_ENV";
};

export function resolveGuestAccessAdmissionE14Config(
  env: Record<string, string | undefined> =
    process.env
): GuestAccessAdmissionE14Config {
  const raw = String(
    env[GUEST_ACCESS_ADMISSION_E14_ENV] ?? ""
  )
    .trim()
    .toLowerCase();

  if (!raw) {
    return {
      enabled: false,
      valid: true,
      source: "DEFAULT_OFF",
    };
  }

  if (raw === "true") {
    return {
      enabled: true,
      valid: true,
      source: "ENV",
    };
  }

  if (raw === "false") {
    return {
      enabled: false,
      valid: true,
      source: "ENV",
    };
  }

  return {
    enabled: false,
    valid: false,
    source: "INVALID_ENV",
  };
}
