import type { OperationalWorkflowState } from "./operational-intelligence-types.js";

export const APMS_OPERATIONAL_TRANSITION_INVALID =
  "APMS_OPERATIONAL_TRANSITION_INVALID";

export const APMS_OPERATIONAL_REOPEN_REQUIRED =
  "APMS_OPERATIONAL_REOPEN_REQUIRED";

export class ApmsOperationalTransitionInvalidError extends Error {
  readonly code = APMS_OPERATIONAL_TRANSITION_INVALID;

  constructor(
    readonly fromWorkflowState: OperationalWorkflowState | null,
    readonly toWorkflowState: OperationalWorkflowState
  ) {
    super(
      `${APMS_OPERATIONAL_TRANSITION_INVALID}: ${fromWorkflowState ?? "NEW"} -> ${toWorkflowState}`
    );
    this.name = "ApmsOperationalTransitionInvalidError";
  }
}

export class ApmsOperationalReopenRequiredError extends Error {
  readonly code = APMS_OPERATIONAL_REOPEN_REQUIRED;

  constructor(readonly toWorkflowState: OperationalWorkflowState) {
    super(
      `${APMS_OPERATIONAL_REOPEN_REQUIRED}: RESOLVED -> ${toWorkflowState} requires an explicit reopen operation`
    );
    this.name = "ApmsOperationalReopenRequiredError";
  }
}

const ACTIVE_WORKFLOW_STATES = [
  "WAITING",
  "AUTO_RESOLVING",
  "ACTION_REQUIRED",
] as const satisfies readonly OperationalWorkflowState[];

const ALLOWED_TRANSITIONS: Readonly<
  Record<OperationalWorkflowState, readonly OperationalWorkflowState[]>
> = {
  WAITING: [
    "WAITING",
    "AUTO_RESOLVING",
    "ACTION_REQUIRED",
    "RESOLVED",
  ],
  AUTO_RESOLVING: [
    "WAITING",
    "AUTO_RESOLVING",
    "ACTION_REQUIRED",
    "RESOLVED",
  ],
  ACTION_REQUIRED: [
    "WAITING",
    "AUTO_RESOLVING",
    "ACTION_REQUIRED",
    "RESOLVED",
  ],
  RESOLVED: ["RESOLVED"],
};

export function isOperationalReopen(
  fromWorkflowState: OperationalWorkflowState | null,
  toWorkflowState: OperationalWorkflowState
): boolean {
  return (
    fromWorkflowState === "RESOLVED" &&
    toWorkflowState !== "RESOLVED"
  );
}

export function isOperationalTransitionAllowed(
  fromWorkflowState: OperationalWorkflowState | null,
  toWorkflowState: OperationalWorkflowState
): boolean {
  if (fromWorkflowState === null) return true;
  if (isOperationalReopen(fromWorkflowState, toWorkflowState)) {
    return false;
  }

  return ALLOWED_TRANSITIONS[fromWorkflowState].includes(
    toWorkflowState
  );
}

export function requireOperationalTransition(
  fromWorkflowState: OperationalWorkflowState | null,
  toWorkflowState: OperationalWorkflowState
): void {
  if (isOperationalReopen(fromWorkflowState, toWorkflowState)) {
    throw new ApmsOperationalReopenRequiredError(
      toWorkflowState
    );
  }

  if (
    !isOperationalTransitionAllowed(
      fromWorkflowState,
      toWorkflowState
    )
  ) {
    throw new ApmsOperationalTransitionInvalidError(
      fromWorkflowState,
      toWorkflowState
    );
  }
}

export function isActiveOperationalWorkflowState(
  workflowState: OperationalWorkflowState
): workflowState is (typeof ACTIVE_WORKFLOW_STATES)[number] {
  return ACTIVE_WORKFLOW_STATES.includes(
    workflowState as (typeof ACTIVE_WORKFLOW_STATES)[number]
  );
}
