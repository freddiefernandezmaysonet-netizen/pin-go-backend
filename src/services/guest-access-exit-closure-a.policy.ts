import type {
  ExecuteGuestAccessProvisioningResult,
} from "../e14/guest-access-admission-fence.service.e14";
import type {
  AccessOwnerCompletion,
} from "./guest-journey-access-owner-runtime.service";

export const GUEST_ACCESS_EXIT_CLOSURE_A_VERSION =
  "guest_access_exit_closure_a_v1" as const;

export type GuestAccessE15MarkerState =
  | "ABSENCE_OBSERVED"
  | "CONFIRMED_ABSENT_REARMABLE"
  | "REARMED"
  | "RECONCILED_PRESENT"
  | "MANUAL_REVIEW_REQUIRED"
  | "VERIFYING_PROVIDER_STATE"
  | null;

export type GuestAccessE15ProviderDecision =
  | "ADOPT_PROVIDER_PRESENT"
  | "RECONCILE_LATE_SUCCESS"
  | "OBSERVE_ABSENCE"
  | "VERIFY_PROVIDER_STATE"
  | "MANUAL_REVIEW_REQUIRED";

export function buildGuestJourneyAccessOwnerE14OwnerId(input: {
  intentId: string;
  attemptNumber: number;
}): string {
  return [
    "guest-journey-access-owner",
    input.intentId,
    input.attemptNumber,
  ].join(":");
}

export function mapGuestJourneyAccessOwnerE14ProvisionResult<T>(
  result: ExecuteGuestAccessProvisioningResult<T>,
  grantId: string
):
  | { proceed: true; activation: T }
  | { proceed: false; completion: AccessOwnerCompletion } {
  if (result.status === "SUCCEEDED") {
    return { proceed: true, activation: result.activation };
  }

  if (
    result.status === "AMBIGUOUS" ||
    result.status === "EXHAUSTED"
  ) {
    return {
      proceed: false,
      completion: {
        kind: "AMBIGUOUS",
        errorCode:
          result.status === "AMBIGUOUS"
            ? "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS"
            : "ACCESS_PROVISIONING_RECOVERY_EXHAUSTED",
        errorDetail:
          `Reservation-level E14 fencing stopped automatic replay: ${result.reason}.`,
        accessGrantIds: [grantId],
      },
    };
  }

  if (result.status === "WAITING_FOR_EVIDENCE") {
    return {
      proceed: false,
      completion: {
        kind: "WAITING_FOR_EVIDENCE",
        errorCode: "ACCESS_PROVISIONING_E14_WAITING_FOR_EVIDENCE",
        errorDetail:
          `Reservation-level E14 fencing is waiting for canonical evidence: ${result.reason}.`,
        accessGrantIds: [grantId],
      },
    };
  }

  return {
    proceed: false,
    completion: {
      kind: "RETRYABLE",
      errorCode:
        result.status === "CLAIM_NOT_ACQUIRED"
          ? `ACCESS_PROVISIONING_E14_CLAIM_${normalizeCode(result.reason)}`
          : `ACCESS_PROVISIONING_E14_RETRYABLE_${normalizeCode(result.reason)}`,
      errorDetail:
        `Reservation-level E14 fencing deferred provider execution: ${result.reason}.`,
      retryAt: result.nextAttemptAt ?? null,
      accessGrantIds: [grantId],
    },
  };
}

function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase() || "UNKNOWN";
}

export function guestAccessE15MarkerStateFromPayload(
  payload: unknown
): GuestAccessE15MarkerState {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const marker = (payload as Record<string, any>).e15;
  if (
    !marker ||
    marker.version !== "guest_access_ambiguity_reconciliation_e15_v1"
  ) {
    return null;
  }
  const state = String(marker.state ?? "").trim();
  return [
    "ABSENCE_OBSERVED",
    "CONFIRMED_ABSENT_REARMABLE",
    "REARMED",
    "RECONCILED_PRESENT",
    "MANUAL_REVIEW_REQUIRED",
    "VERIFYING_PROVIDER_STATE",
  ].includes(state)
    ? state as Exclude<GuestAccessE15MarkerState, null>
    : null;
}

export function decideGuestAccessE15Reconciliation(input: {
  grantStatus: "PENDING" | "ACTIVE";
  recoveryOperation: string | null;
  localKeyboardPwdId: number | null;
  secureCodePresent: boolean;
  provider:
    | { kind: "EXACT_MATCH"; keyboardPwdId: number }
    | { kind: "ABSENT" }
    | { kind: "INCOMPLETE" }
    | { kind: "CONFLICT" };
}): GuestAccessE15ProviderDecision {
  if (input.recoveryOperation !== "GUEST_ACCESS_PROVISION_AMBIGUOUS") {
    return "MANUAL_REVIEW_REQUIRED";
  }
  if (input.provider.kind === "INCOMPLETE") {
    return "VERIFY_PROVIDER_STATE";
  }
  if (input.provider.kind === "CONFLICT") {
    return "MANUAL_REVIEW_REQUIRED";
  }

  if (input.grantStatus === "ACTIVE") {
    if (!input.localKeyboardPwdId || !input.secureCodePresent) {
      return "MANUAL_REVIEW_REQUIRED";
    }
    if (input.provider.kind !== "EXACT_MATCH") {
      return "MANUAL_REVIEW_REQUIRED";
    }
    return input.provider.keyboardPwdId === input.localKeyboardPwdId
      ? "RECONCILE_LATE_SUCCESS"
      : "MANUAL_REVIEW_REQUIRED";
  }

  return input.provider.kind === "EXACT_MATCH"
    ? "ADOPT_PROVIDER_PRESENT"
    : "OBSERVE_ABSENCE";
}

export function isGuestAccessE15AutoResolvableAmbiguity(input: {
  e15Enabled: boolean;
  markerState: GuestAccessE15MarkerState;
}): boolean {
  if (!input.e15Enabled) return false;
  return input.markerState !== "MANUAL_REVIEW_REQUIRED";
}

export function isGuestAccessE15AutoResolvableOwnerExhaustion(input: {
  e15Enabled: boolean;
  intentType: string;
  lastError: string | null;
}): boolean {
  return (
    input.e15Enabled &&
    input.intentType === "REQUEST_ACCESS_PROVISIONING" &&
    String(input.lastError ?? "").toUpperCase().includes("AMBIGUOUS")
  );
}

export function guestAccessE15NextAutomaticStep(
  markerState: GuestAccessE15MarkerState
): string {
  if (markerState === "CONFIRMED_ABSENT_REARMABLE") {
    return "Pin&Go will perform controlled rearm under the reservation-level fence.";
  }
  if (markerState === "ABSENCE_OBSERVED") {
    return "Pin&Go will repeat the read-only provider observation before any rearm.";
  }
  return "Pin&Go will reconcile the fenced access grant against read-only provider evidence without replaying the physical operation.";
}
