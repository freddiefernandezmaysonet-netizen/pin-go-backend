export type IanaTimezoneErrorCodes = {
  required: string;
  invalid: string;
};

const DEFAULT_ERROR_CODES: IanaTimezoneErrorCodes = {
  required: "PROPERTY_TIMEZONE_REQUIRED",
  invalid: "PROPERTY_TIMEZONE_INVALID",
};

export function requireIanaTimezone(
  value: unknown,
  errorCodes: IanaTimezoneErrorCodes = DEFAULT_ERROR_CODES
): string {
  const timezone = String(value ?? "").trim();

  if (!timezone) {
    throw new Error(errorCodes.required);
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    });
    const canonicalTimezone = formatter.resolvedOptions().timeZone;

    if (!canonicalTimezone) {
      throw new Error("timezone_resolution_failed");
    }

    return canonicalTimezone;
  } catch {
    throw new Error(errorCodes.invalid);
  }
}
