import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
  CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS,
  getRetryDelayMs,
  type ChannexAriMessageKind,
} from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_DEFAULT_LEASE_MS = 2 * 60 * 1000;
export const CHANNEX