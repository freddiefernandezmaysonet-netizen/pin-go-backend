import { PmsProvider } from "@prisma/client";

export type PmsWebhookExecutionTarget =
  | "STANDALONE_RECOVERY_WORKER"
  | "API_LEGACY_SET_IMMEDIATE";

export function getPmsWebhookExecutionTarget(
  provider: PmsProvider
): PmsWebhookExecutionTarget {
  return provider === PmsProvider.CHANNEX
    ? "STANDALONE_RECOVERY_WORKER"
    : "API_LEGACY_SET_IMMEDIATE";
}
