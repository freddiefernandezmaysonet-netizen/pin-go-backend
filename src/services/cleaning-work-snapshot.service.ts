/** Configured work evidence only. No acceptance, access or property-readiness authority. */
export type CleaningWorkScope = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  staffMemberId: string;
  confirmationId: string;
}>;

export type CleaningWorkContext = Readonly<{
  reservationStatus: string;
  propertyStatus: string;
  cleaningNfcEnabled: boolean;
  staffActive: boolean;
  assignmentActive: boolean;
  confirmationStatus: string;
  checkOut: Date;
  cleaningStartOffsetMinutes: number;
  durationCommitmentMinutes: number | null;
  startConfirmationGraceMinutes: number;
  followupGraceMinutes: number;
}>;

export type CleaningWorkSnapshot = Readonly<{
  id: string;
  reservationId: string;
  propertyId: string;
  staffMemberId: string;
  confirmationId: string | null;
  scheduledStartAt: Date;
  durationCommitmentMinutes: number;
  startConfirmationGraceMinutes: number;
  followupGraceMinutes: number;
  timingConsentVersion: string | null;
  timingConsentAcceptedAt: Date | null;
  startConfirmedAt: Date | null;
  completionConfirmedAt: Date | null;
  cancelledAt: Date | null;
  supersededAt: Date | null;
}>;

export type NewCleaningWorkSnapshot = Pick<CleaningWorkSnapshot,
  "reservationId" | "propertyId" | "staffMemberId" | "confirmationId" |
  "scheduledStartAt" | "durationCommitmentMinutes" |
  "startConfirmationGraceMinutes" | "followupGraceMinutes">;

export interface CleaningWorkSnapshotTransaction {
  loadContext(scope: CleaningWorkScope): Promise<CleaningWorkContext | null>;
  findExisting(scope: CleaningWorkScope): Promise<CleaningWorkSnapshot | null>;
  hasOtherCurrentWork(scope: CleaningWorkScope): Promise<boolean>;
  create(snapshot: NewCleaningWorkSnapshot): Promise<CleaningWorkSnapshot>;
}

export interface CleaningWorkSnapshotStore {
  /** Production adapter must serialize reservation-scoped creation and retry write conflicts. */
  transaction<T>(run: (tx: CleaningWorkSnapshotTransaction) => Promise<T>): Promise<T>;
}

export class CleaningWorkSnapshotError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CleaningWorkSnapshotError";
  }
}

export type CleaningWorkSnapshotResult = Readonly<{
  outcome: "CREATED" | "REPLAYED" | "EXISTING_CLOSED" | "NOT_CONFIGURED";
  work: CleaningWorkSnapshot | null;
  // Existing availability acceptance does not prove acceptance of new timing terms.
  timingCommitmentAccepted: false;
  propertyReady: false;
}>;

function fail(code: string): never {
  throw new CleaningWorkSnapshotError(code);
}

function checkDate(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("CLEANING_WORK_INVALID_DATE");
  }
  return value.getTime();
}

function checkMinutes(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("CLEANING_WORK_INVALID_TIMING");
  }
  return value;
}

function result(outcome: CleaningWorkSnapshotResult["outcome"], work: CleaningWorkSnapshot | null): CleaningWorkSnapshotResult {
  return { outcome, work, timingCommitmentAccepted: false, propertyReady: false };
}

function validateStored(work: CleaningWorkSnapshot): void {
  checkDate(work.scheduledStartAt);
  checkMinutes(work.durationCommitmentMinutes, 15, 1440);
  checkMinutes(work.startConfirmationGraceMinutes, 5, 240);
  checkMinutes(work.followupGraceMinutes, 5, 240);
  for (const date of [work.timingConsentAcceptedAt, work.startConfirmedAt, work.completionConfirmedAt, work.cancelledAt, work.supersededAt]) {
    if (date !== null) checkDate(date);
  }
}

/**
 * Creates an immutable copy of current Staff timings for one confirmed assignment.
 * Deliberately not called by live routes/workers in this slice: explicit timing consent
 * and cancellation/reassignment orchestration must be integrated before activation.
 * Existing records are never overwritten or re-opened; old confirmations are not scanned.
 */
export async function materializeCleaningWorkSnapshot(
  store: CleaningWorkSnapshotStore,
  scope: CleaningWorkScope,
  now = new Date(),
): Promise<CleaningWorkSnapshotResult> {
  const nowMs = checkDate(now);
  const keys = ["organizationId", "propertyId", "reservationId", "staffMemberId", "confirmationId"];
  if (!scope || typeof scope !== "object" || Object.keys(scope).length !== keys.length ||
      keys.some(key => !Object.hasOwn(scope, key))) fail("CLEANING_WORK_INVALID_SCOPE");
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      fail("CLEANING_WORK_INVALID_SCOPE");
    }
  }

  return store.transaction(async tx => {
    const context = await tx.loadContext(scope);
    if (!context) fail("CLEANING_WORK_OUT_OF_SCOPE");
    if (context.reservationStatus !== "ACTIVE" || context.propertyStatus !== "ACTIVE" ||
        !context.staffActive || !context.assignmentActive) {
      fail("CLEANING_WORK_INACTIVE_CONTEXT");
    }
    if (!context.cleaningNfcEnabled) fail("CLEANING_WORK_NFC_FLOW_DISABLED");
    if (context.confirmationStatus !== "CONFIRMED") fail("CLEANING_WORK_CONFIRMATION_REQUIRED");

    const startMs = checkDate(context.checkOut) +
      checkMinutes(context.cleaningStartOffsetMinutes, 0, 1440) * 60_000;
    const scheduledStartAt = new Date(startMs);
    checkDate(scheduledStartAt);
    const existing = await tx.findExisting(scope);
    if (existing) {
      if (existing.reservationId !== scope.reservationId || existing.propertyId !== scope.propertyId ||
          existing.staffMemberId !== scope.staffMemberId || existing.confirmationId !== scope.confirmationId) {
        fail("CLEANING_WORK_SNAPSHOT_BINDING_CONFLICT");
      }
      validateStored(existing);
      if (existing.cancelledAt || existing.supersededAt || existing.completionConfirmedAt) {
        return result("EXISTING_CLOSED", existing);
      }
      if (existing.scheduledStartAt.getTime() !== startMs) {
        fail("CLEANING_WORK_SCHEDULE_CHANGED");
      }
      // Staff edits affect future work only, not a materialized snapshot.
      return result("REPLAYED", existing);
    }

    if (context.durationCommitmentMinutes === null) return result("NOT_CONFIGURED", null);
    // No retroactive activation: a legacy confirmation/link opened after its scheduled
    // cleaning start cannot create a new Follow-up V1 work item.
    if (startMs < nowMs) fail("CLEANING_WORK_RETROACTIVE_ACTIVATION_BLOCKED");
    if (await tx.hasOtherCurrentWork(scope)) fail("CLEANING_WORK_REASSIGNMENT_REQUIRES_REVIEW");
    const snapshot: NewCleaningWorkSnapshot = {
      reservationId: scope.reservationId,
      propertyId: scope.propertyId,
      staffMemberId: scope.staffMemberId,
      confirmationId: scope.confirmationId,
      scheduledStartAt,
      durationCommitmentMinutes: checkMinutes(context.durationCommitmentMinutes, 15, 1440),
      startConfirmationGraceMinutes: checkMinutes(context.startConfirmationGraceMinutes, 5, 240),
      followupGraceMinutes: checkMinutes(context.followupGraceMinutes, 5, 240),
    };
    return result("CREATED", await tx.create(snapshot));
  });
}
