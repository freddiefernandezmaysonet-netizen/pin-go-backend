import type { CleaningFollowupDecision } from "./cleaning-followup.policy.js";

export type CleaningFollowupReceiptKind = "START_REMINDER" | "COMPLETION_REMINDER" | "HOST_ATTENTION";

export type CleaningFollowupDue = Readonly<{
  kind: CleaningFollowupReceiptKind;
  dueAt: Date;
}>;

export function followupDueForDecision(input: Readonly<{
  decision: CleaningFollowupDecision;
  startReminderAt: Date;
  scheduledCompletionAt: Date;
  hostAttentionAt: Date;
}>): CleaningFollowupDue | null {
  switch (input.decision) {
    case "START_REMINDER_DUE":
      return { kind: "START_REMINDER", dueAt: input.startReminderAt };
    case "COMPLETION_REMINDER_DUE":
      return { kind: "COMPLETION_REMINDER", dueAt: input.scheduledCompletionAt };
    case "HOST_ATTENTION_DUE":
      return { kind: "HOST_ATTENTION", dueAt: input.hostAttentionAt };
    default:
      return null;
  }
}

export type CleaningFollowupClaimResult = Readonly<{ status: "CLAIMED" | "ALREADY_CLAIMED"; receiptId: string }>;

export interface CleaningFollowupReceiptStore {
  claim(input: Readonly<{ cleaningWorkId: string; kind: CleaningFollowupReceiptKind; dueAt: Date }>): Promise<CleaningFollowupClaimResult>;
}

export async function claimCleaningFollowupDue(
  store: CleaningFollowupReceiptStore,
  cleaningWorkId: string,
  due: CleaningFollowupDue | null,
): Promise<Readonly<{ status: "NOT_DUE"; receiptId: null }> | CleaningFollowupClaimResult> {
  if (!due) return { status: "NOT_DUE", receiptId: null };
  if (typeof cleaningWorkId !== "string" || cleaningWorkId.length < 1 || !Number.isFinite(due.dueAt.getTime())) {
    throw new Error("CLEANING_FOLLOWUP_RECEIPT_INVALID");
  }
  return store.claim({ cleaningWorkId, kind: due.kind, dueAt: due.dueAt });
}
