export type CleaningFollowupSnapshot = Readonly<{
  scheduledStartAt: Date;
  durationMinutes: number;
  startConfirmationGraceMinutes: number;
  followupGraceMinutes: number;
  startConfirmedAt: Date | null;
  completionConfirmedAt: Date | null;
  cancelled: boolean;
}>;

export type CleaningFollowupDecision =
  | "WAITING_FOR_SCHEDULED_START"
  | "WAITING_FOR_START_CONFIRMATION"
  | "START_REMINDER_DUE"
  | "CLEANING_IN_PROGRESS"
  | "COMPLETION_REMINDER_DUE"
  | "HOST_ATTENTION_DUE"
  | "COMPLETED"
  | "CANCELLED";

export function evaluateCleaningFollowup(
  input: CleaningFollowupSnapshot,
  now: Date,
): Readonly<{
  decision: CleaningFollowupDecision;
  scheduledCompletionAt: Date;
  startReminderAt: Date;
  hostAttentionAt: Date;
}> {
  const minute = 60_000;
  const scheduledCompletionAt = new Date(
    input.scheduledStartAt.getTime() + input.durationMinutes * minute,
  );
  const startReminderAt = new Date(
    input.scheduledStartAt.getTime() + input.startConfirmationGraceMinutes * minute,
  );
  const hostAttentionAt = new Date(
    scheduledCompletionAt.getTime() + input.followupGraceMinutes * minute,
  );

  if (input.cancelled) {
    return { decision: "CANCELLED", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (input.completionConfirmedAt) {
    return { decision: "COMPLETED", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (now < input.scheduledStartAt) {
    return { decision: "WAITING_FOR_SCHEDULED_START", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (!input.startConfirmedAt && now < startReminderAt) {
    return { decision: "WAITING_FOR_START_CONFIRMATION", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (!input.startConfirmedAt && now < scheduledCompletionAt) {
    return { decision: "START_REMINDER_DUE", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (now < scheduledCompletionAt) {
    return { decision: "CLEANING_IN_PROGRESS", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  if (now < hostAttentionAt) {
    return { decision: "COMPLETION_REMINDER_DUE", scheduledCompletionAt, startReminderAt, hostAttentionAt };
  }
  return { decision: "HOST_ATTENTION_DUE", scheduledCompletionAt, startReminderAt, hostAttentionAt };
}
