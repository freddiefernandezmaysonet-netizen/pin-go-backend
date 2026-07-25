export type StagingReadinessCheckStatus = "PASS" | "FAIL" | "WARNING";

export type StagingReadinessCheck = {
  code: string;
  status: StagingReadinessCheckStatus;
  detail: string;
};

export type ChannexStagingListingReadiness = {
  externalListingId: string | null;
  channexPropertyId: string | null;
  webhookId: string | null;
  webhookCallbackUrl: string | null;
  webhookEventMask: string | null;
  webhookSendData: boolean | null;
  webhookConfiguredAt: string | null;
};

export type ChannexStagingReadinessInput = {
  nodeEnv: string | null;
  databaseConfigured: boolean;
  apiBaseUrl: string | null;
  callbackUrl: string | null;
  propertyId: string | null;
  propertyFound: boolean;
  propertyStatus: string | null;
  connectionCount: number;
  connectionStatus: string | null;
  webhookSecretPresent: boolean;
  listings: ChannexStagingListingReadiness[];
  worker: {
    pollMs: number;
    batchSize: number;
    maxAttempts: number;
    pendingMinAgeMs: number;
    retryDelayMs: number;
    staleProcessingMs: number;
  };
};

function addCheck(
  checks: StagingReadinessCheck[],
  code: string,
  passed: boolean,
  passDetail: string,
  failDetail: string,
  failureStatus: Exclude<StagingReadinessCheckStatus, "PASS"> = "FAIL"
) {
  checks.push({
    code,
    status: passed ? "PASS" : failureStatus,
    detail: passed ? passDetail : failDetail,
  });
}

function normalize(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isValidStagingApiBaseUrl(value: string | null) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && url.hostname === "staging.channex.io";
  } catch {
    return false;
  }
}

function isValidCallbackUrl(value: string | null) {
  try {
    const url = new URL(String(value ?? ""));
    return (
      url.protocol === "https:" &&
      url.pathname.endsWith("/webhooks/channex") &&
      url.hostname !== "api.pin-ngo.com"
    );
  } catch {
    return false;
  }
}

function isFiniteIntegerInRange(
  value: number,
  min: number,
  max: number
) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function evaluateChannexStagingReadiness(
  input: ChannexStagingReadinessInput
) {
  const checks: StagingReadinessCheck[] = [];
  const nodeEnv = normalize(input.nodeEnv)?.toLowerCase() ?? null;
  const callbackUrl = normalize(input.callbackUrl);

  addCheck(
    checks,
    "ENVIRONMENT_IS_STAGING",
    nodeEnv === "staging",
    "NODE_ENV is staging.",
    "NODE_ENV must be exactly staging."
  );
  addCheck(
    checks,
    "DATABASE_URL_CONFIGURED",
    input.databaseConfigured,
    "DATABASE_URL is configured.",
    "DATABASE_URL is missing."
  );
  addCheck(
    checks,
    "CHANNEX_API_IS_STAGING",
    isValidStagingApiBaseUrl(input.apiBaseUrl),
    "Channex API points to staging.channex.io.",
    "CHANNEX_API_BASE_URL must point to https://staging.channex.io."
  );
  addCheck(
    checks,
    "CALLBACK_IS_SAFE_STAGING_HTTPS",
    isValidCallbackUrl(callbackUrl),
    "Webhook callback is HTTPS, uses /webhooks/channex and is not production.",
    "Webhook callback must be a non-production HTTPS URL ending in /webhooks/channex."
  );
  addCheck(
    checks,
    "PROPERTY_ID_CONFIGURED",
    Boolean(normalize(input.propertyId)),
    "A Pin&Go staging property ID is configured.",
    "PIN_GO_PROPERTY_ID is missing."
  );
  addCheck(
    checks,
    "PROPERTY_EXISTS",
    input.propertyFound,
    "The staging property exists.",
    "The configured staging property was not found."
  );
  addCheck(
    checks,
    "PROPERTY_IS_ACTIVE",
    input.propertyStatus === "ACTIVE",
    "The staging property is active.",
    "The staging property must be ACTIVE."
  );
  addCheck(
    checks,
    "SINGLE_ACTIVE_CHANNEX_CONNECTION",
    input.connectionCount === 1 && input.connectionStatus === "ACTIVE",
    "Exactly one active Channex connection owns the property mappings.",
    "The property must resolve to exactly one ACTIVE Channex connection."
  );
  addCheck(
    checks,
    "WEBHOOK_SECRET_CONFIGURED",
    input.webhookSecretPresent,
    "The Channex connection has a webhook secret.",
    "The Channex connection webhook secret is missing."
  );
  addCheck(
    checks,
    "LISTINGS_PRESENT",
    input.listings.length > 0,
    "At least one Channex room type mapping exists.",
    "No Channex room type mappings exist for the property."
  );

  const propertyIds = new Set(
    input.listings
      .map((listing) => normalize(listing.channexPropertyId))
      .filter((value): value is string => Boolean(value))
  );
  addCheck(
    checks,
    "SINGLE_CHANNEX_PROPERTY_MAPPING",
    input.listings.length > 0 &&
      propertyIds.size === 1 &&
      input.listings.every((listing) => Boolean(normalize(listing.channexPropertyId))),
    "All room types map to one Channex property ID.",
    "Every room type must map to the same non-empty Channex property ID."
  );
  addCheck(
    checks,
    "ROOM_TYPE_IDS_PRESENT",
    input.listings.length > 0 &&
      input.listings.every((listing) => Boolean(normalize(listing.externalListingId))),
    "All listings contain Channex room type IDs.",
    "Every listing must contain a Channex room type ID."
  );
  addCheck(
    checks,
    "WEBHOOK_REGISTRATION_METADATA_PRESENT",
    input.listings.length > 0 &&
      input.listings.every(
        (listing) =>
          Boolean(normalize(listing.webhookId)) &&
          Boolean(normalize(listing.webhookConfiguredAt))
      ),
    "All room type mappings contain the registered webhook identity.",
    "Webhook registration metadata is incomplete."
  );
  addCheck(
    checks,
    "WEBHOOK_CALLBACK_MATCHES",
    Boolean(callbackUrl) &&
      input.listings.length > 0 &&
      input.listings.every(
        (listing) => normalize(listing.webhookCallbackUrl) === callbackUrl
      ),
    "Stored webhook callbacks match the configured staging callback.",
    "Stored webhook callback metadata does not match the configured callback."
  );
  addCheck(
    checks,
    "WEBHOOK_EVENT_MASK_IS_BOOKING",
    input.listings.length > 0 &&
      input.listings.every(
        (listing) => normalize(listing.webhookEventMask) === "booking"
      ),
    "Webhook event mask is booking.",
    "Webhook event mask must be booking."
  );
  addCheck(
    checks,
    "WEBHOOK_SEND_DATA_DISABLED",
    input.listings.length > 0 &&
      input.listings.every((listing) => listing.webhookSendData === false),
    "Webhook send_data is disabled.",
    "Webhook send_data must be false."
  );

  addCheck(
    checks,
    "WORKER_POLL_INTERVAL_SAFE",
    isFiniteIntegerInRange(input.worker.pollMs, 1_000, 300_000),
    "Worker poll interval is within the certification range.",
    "PMS_WEBHOOK_RECOVERY_POLL_MS must be an integer from 1000 to 300000."
  );
  addCheck(
    checks,
    "WORKER_BATCH_SIZE_SAFE",
    isFiniteIntegerInRange(input.worker.batchSize, 1, 100),
    "Worker batch size is within the certification range.",
    "PMS_WEBHOOK_RECOVERY_BATCH_SIZE must be an integer from 1 to 100."
  );
  addCheck(
    checks,
    "WORKER_MAX_ATTEMPTS_SAFE",
    isFiniteIntegerInRange(input.worker.maxAttempts, 1, 20),
    "Worker maximum attempts are within the certification range.",
    "PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS must be an integer from 1 to 20."
  );
  addCheck(
    checks,
    "WORKER_PENDING_AGE_SAFE",
    isFiniteIntegerInRange(input.worker.pendingMinAgeMs, 0, 300_000),
    "Worker pending minimum age is within the certification range.",
    "PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS must be an integer from 0 to 300000."
  );
  addCheck(
    checks,
    "WORKER_RETRY_DELAY_SAFE",
    isFiniteIntegerInRange(input.worker.retryDelayMs, 1_000, 3_600_000),
    "Worker retry delay is within the certification range.",
    "PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS must be an integer from 1000 to 3600000."
  );
  addCheck(
    checks,
    "WORKER_STALE_LEASE_SAFE",
    isFiniteIntegerInRange(input.worker.staleProcessingMs, 60_000, 86_400_000),
    "Worker stale-processing lease is within the certification range.",
    "PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS must be an integer from 60000 to 86400000."
  );

  const failedChecks = checks.filter((check) => check.status === "FAIL");
  const warningChecks = checks.filter((check) => check.status === "WARNING");

  return {
    ready: failedChecks.length === 0,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "PASS").length,
      failed: failedChecks.length,
      warnings: warningChecks.length,
    },
    checks,
  };
}
