/**
 * Pure classification of unresolved sales voice call records.
 * No database mutations, timers, network requests or provider operations.
 * This module is not mounted in the server or imported by a worker.
 */
export type RecoveryState =
  | "VERIFY_ACCEPT"
  | "VERIFY_SESSION"
  | "VERIFY_HANGUP"
  | "WAIT_FOR_CONFIRMED_CLOSE"
  | "IGNORE_FINALIZED";

export function classifySalesVoiceRecovery(status: string, finalized: boolean): RecoveryState {
  if (finalized) return "IGNORE_FINALIZED";
  if (status === "ACCEPTED") return "VERIFY_SESSION";
  if (status === "HANGUP_SENT") return "WAIT_FOR_CONFIRMED_CLOSE";
  if (status === "HANGUP_CLAIMED" || status === "HANGUP_UNKNOWN") return "VERIFY_HANGUP";
  return "VERIFY_ACCEPT";
}
