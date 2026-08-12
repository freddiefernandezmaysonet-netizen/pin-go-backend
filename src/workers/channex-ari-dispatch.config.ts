import {
  CHANNEX_ARI_DEFAULT_LEASE_MS,
  CHANNEX_ARI_MAX_LEASE_MS,
  CHANNEX_ARI_MIN_LEASE_MS,
} from "../pms/outbound/channex-ari-dispatch.policy";
import {
  CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS,
  CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS,
} from "../pms/outbound/channex-ari-delivery-executor.service";
import {
  CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS,
  CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS,
} from "../pms/outbound/channex-ari-http.client";
import {
  CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
  CHANNEX_ARI_MAX_SELECTION_LIMIT,
} from "../pms/outbound/channex-ari-job-selection.policy";
import { CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT } from "../pms/outbound/channex-ari-job-selection.service";

export const CHANNEX_ARI_DISPATCH_DEFAULT_POLL_MS = 10_000;
export const CHANNEX_ARI_DISPATCH_MIN_POLL_MS = 1_000;
export const CHANNEX_ARI_DISPATCH_MAX_POLL_MS = 300_000;
export const CHANNEX_ARI_DISPATCH_MAX_COMPLETION_RESERVE_MS = 60_000;
export const CHANNEX_ARI_DISPATCH_MAX_JITTER_MS = 5_000;

export type ChannexAriDispatchConfig = {
  pollMs: number;
  selectionLimit: number;
  candidateScanLimit: number;
  leaseMs: number;
  timeoutMs: number;
  completionReserveMs: number;
  jitterMs: number;
};

function parseIntegerEnv(input: {
  name: string;
  rawValue: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = String(input.rawValue ?? "").trim();
  const value = raw ? Number(raw) : input.fallback;

  if (
    !Number.isSafeInteger(value) ||
    value < input.min ||
    value > input.max
  ) {
    throw new Error(
      `${input.name}_INVALID: expected integer ${input.min}-${input.max}`
    );
  }

  return value;
}

export function resolveChannexAriDispatchConfig(
  env: NodeJS.ProcessEnv = process.env
): ChannexAriDispatchConfig {
  const selectionLimit = parseIntegerEnv({
    name: "CHANNEX_ARI_DISPATCH_SELECTION_LIMIT",
    rawValue: env.CHANNEX_ARI_DISPATCH_SELECTION_LIMIT,
    fallback: CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
    min: 1,
    max: CHANNEX_ARI_MAX_SELECTION_LIMIT,
  });
  const candidateScanLimit = parseIntegerEnv({
    name: "CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT",
    rawValue: env.CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT,
    fallback: Math.min(
      CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT,
      selectionLimit * 10
    ),
    min: selectionLimit,
    max: CHANNEX_ARI_MAX_SELECTION_SCAN_LIMIT,
  });
  const leaseMs = parseIntegerEnv({
    name: "CHANNEX_ARI_DISPATCH_LEASE_MS",
    rawValue: env.CHANNEX_ARI_DISPATCH_LEASE_MS,
    fallback: CHANNEX_ARI_DEFAULT_LEASE_MS,
    min: CHANNEX_ARI_MIN_LEASE_MS,
    max: CHANNEX_ARI_MAX_LEASE_MS,
  });
  const timeoutMs = parseIntegerEnv({
    name: "CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS",
    rawValue: env.CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS,
    fallback: CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS,
    min: CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS,
    max: CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS,
  });
  const completionReserveMs = parseIntegerEnv({
    name: "CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS",
    rawValue: env.CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS,
    fallback: CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS,
    min: 0,
    max: CHANNEX_ARI_DISPATCH_MAX_COMPLETION_RESERVE_MS,
  });

  if (leaseMs < timeoutMs + completionReserveMs) {
    throw new Error(
      "CHANNEX_ARI_DISPATCH_LEASE_BUDGET_INVALID: lease must cover HTTP timeout plus completion reserve"
    );
  }

  return {
    pollMs: parseIntegerEnv({
      name: "CHANNEX_ARI_DISPATCH_POLL_MS",
      rawValue: env.CHANNEX_ARI_DISPATCH_POLL_MS,
      fallback: CHANNEX_ARI_DISPATCH_DEFAULT_POLL_MS,
      min: CHANNEX_ARI_DISPATCH_MIN_POLL_MS,
      max: CHANNEX_ARI_DISPATCH_MAX_POLL_MS,
    }),
    selectionLimit,
    candidateScanLimit,
    leaseMs,
    timeoutMs,
    completionReserveMs,
    jitterMs: parseIntegerEnv({
      name: "CHANNEX_ARI_DISPATCH_JITTER_MS",
      rawValue: env.CHANNEX_ARI_DISPATCH_JITTER_MS,
      fallback: 0,
      min: 0,
      max: CHANNEX_ARI_DISPATCH_MAX_JITTER_MS,
    }),
  };
}
