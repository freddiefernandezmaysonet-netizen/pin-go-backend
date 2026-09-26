export type PinAIActionCanaryReason =
  | "FLAGS_DISABLED"
  | "ALLOWLIST_EMPTY"
  | "ALLOWLIST_INVALID"
  | "RESERVATION_NOT_SELECTED"
  | "CANARY_ACTIVE";

export type PinAIActionCanaryResolution =
  Readonly<{
    enabled: boolean;
    reason:
      PinAIActionCanaryReason;
    reservationId: string;
    selectedReservationIds:
      ReadonlySet<string>;
  }>;

const RESERVATION_ID_PATTERN =
  /^[A-Za-z0-9_-]{8,128}$/;

function normalizeReservationId(
  value: unknown,
): string {
  return typeof value === "string"
    ? value.trim()
    : "";
}

export function parsePinAIActionCanaryReservationIds(
  value: unknown,
): Readonly<{
  valid: boolean;
  ids: ReadonlySet<string>;
}> {
  const raw =
    String(value ?? "").trim();

  if (!raw) {
    return {
      valid: true,
      ids: new Set<string>(),
    };
  }

  const entries =
    raw
      .split(",")
      .map((entry) =>
        entry.trim(),
      )
      .filter(Boolean);

  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        !RESERVATION_ID_PATTERN.test(
          entry,
        ),
    )
  ) {
    return {
      valid: false,
      ids: new Set<string>(),
    };
  }

  return {
    valid: true,
    ids: new Set(entries),
  };
}

export function resolvePinAIActionCanaryScope(
  input: Readonly<{
    reservationId: unknown;
    env: Pick<
      NodeJS.ProcessEnv,
      | "PIN_AI_ACTION_BROKER_ENABLED"
      | "PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED"
      | "PIN_AI_ACTION_CANARY_RESERVATION_IDS"
    >;
  }>,
): PinAIActionCanaryResolution {
  const reservationId =
    normalizeReservationId(
      input.reservationId,
    );

  const flagsEnabled =
    input.env
      .PIN_AI_ACTION_BROKER_ENABLED ===
      "true" &&
    input.env
      .PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED ===
      "true";

  const parsed =
    parsePinAIActionCanaryReservationIds(
      input.env
        .PIN_AI_ACTION_CANARY_RESERVATION_IDS,
    );

  if (!flagsEnabled) {
    return {
      enabled: false,
      reason:
        "FLAGS_DISABLED",
      reservationId,
      selectedReservationIds:
        parsed.ids,
    };
  }

  if (!parsed.valid) {
    return {
      enabled: false,
      reason:
        "ALLOWLIST_INVALID",
      reservationId,
      selectedReservationIds:
        parsed.ids,
    };
  }

  if (
    parsed.ids.size === 0
  ) {
    return {
      enabled: false,
      reason:
        "ALLOWLIST_EMPTY",
      reservationId,
      selectedReservationIds:
        parsed.ids,
    };
  }

  if (
    !reservationId ||
    !parsed.ids.has(
      reservationId,
    )
  ) {
    return {
      enabled: false,
      reason:
        "RESERVATION_NOT_SELECTED",
      reservationId,
      selectedReservationIds:
        parsed.ids,
    };
  }

  return {
    enabled: true,
    reason:
      "CANARY_ACTIVE",
    reservationId,
    selectedReservationIds:
      parsed.ids,
  };
}
