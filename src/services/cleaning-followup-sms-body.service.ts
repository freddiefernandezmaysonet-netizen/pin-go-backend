export type CleaningFollowupDeliveryKind = "START_REMINDER" | "COMPLETION_REMINDER";

export function buildCleanerFollowupSms(input: Readonly<{
  kind: CleaningFollowupDeliveryKind;
  propertyName: string;
  actionUrl: string;
}>): string {
  const property = input.propertyName.replace(/\s+/g, " ").trim().slice(0, 40) || "property";
  const url = input.actionUrl.trim();
  if (!/^https:\/\//i.test(url)) throw new Error("CLEANING_FOLLOWUP_ACTION_URL_REQUIRED");
  if (input.kind === "START_REMINDER") {
    return `Pin&Go reminder: cleaning at ${property} has not been marked started. If you already started, confirm here; otherwise report the delay: ${url}`;
  }
  return `Pin&Go reminder: cleaning at ${property} has reached its committed completion time and is not marked finished. Confirm completion or update your status: ${url}`;
}
