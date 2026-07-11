/**
 * Shared operational intelligence contracts for Pin&Go APMS engines.
 *
 * AuditEntry explains what an engine executed.
 * OperationalItem represents the current operational state of a real workflow.
 *
 * Mission Control and Pin AI should consume these structured contracts instead
 * of interpreting engine names, free-text reasons or audit metadata.
 */

export type OperationalWorkflowState =
  | "ACTION_REQUIRED"
  | "WAITING"
  | "AUTO_RESOLVING"
  | "RESOLVED";

export type OperationalVisibility =
  | "HOST"
  | "SYSTEM"
  | "DEVELOPER";

export type OperationalActor =
  | "HOST"
  | "PIN_GO"
  | "PIN_AI"
  | "GUEST"
  | "CLEANER"
  | "STAFF"
  | "SYSTEM"
  | "NONE";

export type OperationalSeverity =
  | "INFO"
  | "WARNING"
  | "CRITICAL";

export type OperationalAutoResolveStatus =
  | "AVAILABLE"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "NOT_SUPPORTED";

export type OperationalActionTarget =
  | "RESERVATION"
  | "PROPERTY"
  | "CLEANING"
  | "ACCESS"
  | "DISTRIBUTION"
  | "PAYMENT"
  | "MESSAGING"
  | "GUEST"
  | "STAFF"
  | "SYSTEM";

export type OperationalSourceType =
  | "AUDIT_ENTRY"
  | "ENGINE_EVENT"
  | "WORKER"
  | "MANUAL"
  | "PIN_AI";

export type OperationalResolutionType =
  | "AUTOMATIC"
  | "MANUAL"
  | "EXPIRED"
  | "SUPERSEDED";

/**
 * Current persisted operational state.
 *
 * One OperationalItem represents one workflow identified by operationalKey.
 * Repeated audits or retries must update the same workflow instead of creating
 * duplicate host actions.
 */
export interface OperationalItem {
  /**
   * Persisted OperationalIssue identifier.
   * Internal only. Never display this value to hosts or guests.
   */
  issueId: string;

  /**
   * Stable identity of the operational workflow.
   *
   * Example:
   * CLEANING_CONFIRMATION:<cleaningConfirmationId>
   */
  operationalKey: string;

  /**
   * Current structured condition inside the workflow.
   *
   * Examples:
   * CLEANING_CONFIRMATION_PENDING
   * CLEANING_CONFIRMATION_DECLINED
   * CLEANING_CONFIRMATION_CONFIRMED
   */
  issueCode: string;

  /**
   * Host-friendly title.
   */
  title: string;

  /**
   * Exact explanation of what occurred.
   */
  issue: string;

  /**
   * Explanation of why the condition matters operationally.
   */
  operationalImpact?: string | null;

  /**
   * Human action recommended by Pin&Go.
   */
  recommendedAction?: string | null;

  /**
   * What Pin&Go will do automatically after the current state.
   */
  nextAutomaticStep?: string | null;

  /**
   * APMS engine responsible for the operational signal.
   */
  engine: string;

  severity: OperationalSeverity;
  workflowState: OperationalWorkflowState;
  visibility: OperationalVisibility;
  responsibleActor: OperationalActor;

  /**
   * True only when a human must act.
   */
  actionRequired: boolean;

  /**
   * Indicates that Pin&Go has an automated continuation or repair path.
   */
  canAutoResolve: boolean;

  /**
   * Explicit auto-resolution state.
   *
   * Use NOT_SUPPORTED when no automated repair is available.
   */
  autoResolveStatus: OperationalAutoResolveStatus;

  /**
   * Registered internal action identifier.
   *
   * Pin&Go and Pin AI must never execute recommendedAction as free text.
   * Only registered action codes may trigger automation.
   */
  autoResolveActionCode?: string | null;

  /**
   * Internal Prisma reservation identifier.
   *
   * May be used for relations and navigation.
   * Never display this value to hosts or guests.
   */
  reservationId?: string | null;

  /**
   * Official host-facing and guest-facing reservation reference.
   */
  reservationNumber?: string | null;

  propertyId?: string | null;
  organizationId?: string | null;

  guestName?: string | null;
  staffMemberId?: string | null;
  cleanerName?: string | null;

  /**
   * Audit and source traceability.
   */
  decisionId?: string | null;
  sourceAuditEntryId?: string | null;
  sourceType: OperationalSourceType;

  firstDetectedAt: Date | string;
  lastSignalAt: Date | string;
  resolvedAt?: Date | string | null;

  resolutionCode?: string | null;
  resolutionSummary?: string | null;
  resolutionType?: OperationalResolutionType | null;
  resolvedBy?: OperationalActor | null;

  /**
   * Destination used to determine the correct operational screen.
   */
  actionTarget: OperationalActionTarget;

  /**
   * URLs are response helpers and should not be used as operational identity.
   */
  openUrl?: string | null;
  secondaryActionUrl?: string | null;

  /**
   * Engine-specific technical context.
   *
   * The host API must filter internal metadata before returning an item.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Input used to create or update the current operational workflow.
 *
 * issueId is intentionally omitted because Prisma will generate it when a new
 * OperationalIssue is created.
 */
export type UpsertOperationalItemInput = Omit<
  OperationalItem,
  "issueId" | "firstDetectedAt" | "lastSignalAt"
> & {
  firstDetectedAt?: Date;
  lastSignalAt?: Date;
};

/**
 * Immutable history entry for an operational workflow transition.
 *
 * Examples:
 * null -> WAITING
 * WAITING -> ACTION_REQUIRED
 * WAITING -> AUTO_RESOLVING
 * AUTO_RESOLVING -> RESOLVED
 */
export interface OperationalIssueTransition {
  transitionId: string;
  issueId: string;
  operationalKey: string;
  issueCode: string;

  fromWorkflowState?: OperationalWorkflowState | null;
  toWorkflowState: OperationalWorkflowState;

  transitionCode: string;
  transitionSummary: string;
  transitionedBy: OperationalActor;

  sourceType: OperationalSourceType;
  decisionId?: string | null;
  sourceAuditEntryId?: string | null;

  occurredAt: Date | string;

  metadata?: Record<string, unknown>;
}