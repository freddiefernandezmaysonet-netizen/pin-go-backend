export type CleaningTimingUpdate = {
  cleaningDurationCommitmentMinutes?: number | null;
  cleaningStartConfirmationGraceMinutes?: number;
  cleaningFollowupGraceMinutes?: number;
};

export class CleaningTimingValidationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid cleaning timing: ${field}`);
    this.name = "CleaningTimingValidationError";
  }
}

function wholeMinutes(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CleaningTimingValidationError(field);
  }
  return parsed;
}

/** Omitted fields stay omitted: older Staff forms must not erase saved timings. */
export function parseCleaningTimingUpdate(input: Record<string, unknown>): CleaningTimingUpdate {
  const result: CleaningTimingUpdate = {};
  const duration = "cleaningDurationCommitmentMinutes";
  const start = "cleaningStartConfirmationGraceMinutes";
  const followup = "cleaningFollowupGraceMinutes";
  if (Object.hasOwn(input, duration) && input[duration] !== undefined) {
    result[duration] = input[duration] === null || input[duration] === "" ? null :
      wholeMinutes(input[duration], duration, 15, 1440);
  }
  if (Object.hasOwn(input, start) && input[start] !== undefined) {
    result[start] = wholeMinutes(input[start], start, 5, 240);
  }
  if (Object.hasOwn(input, followup) && input[followup] !== undefined) {
    result[followup] = wholeMinutes(input[followup], followup, 5, 240);
  }
  return result;
}
