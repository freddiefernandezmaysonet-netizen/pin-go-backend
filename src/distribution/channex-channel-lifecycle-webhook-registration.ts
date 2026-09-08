import crypto from "node:crypto";

import {
  ChannexChannelLifecycleWebhookContractError,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER,
  buildChannexChannelLifecycleWebhookPayload,
  hasCompleteOtaChannelLifecycleEventMask,
  normalizeChannexUuid,
  normalizeOtaChannelLifecycleWebhookCallbackUrl,
  parseOtaChannelLifecycleEventMask,
  type ChannexChannelLifecycleWebhookWritePayload,
} from "./channex-channel-lifecycle-webhook.contract.js";
import {
  buildOtaChannelLifecycleRegistrationApplyConfirmation,
  type OtaChannelLifecycleWebhookRegistrationConfig,
} from "./channex-channel-lifecycle-webhook-registration.config.js";

const CHANNEX_STAGING_API_ORIGIN = "https://staging.channex.io";

export type ChannexWebhookSnapshot = {
  id: string;
  propertyId: string | null;
  callbackUrl: string;
  eventMask: string;
  headers: Readonly<Record<string, string>> | null;
  isActive: boolean;
  sendData: boolean;
  isGlobal: boolean;
  isProtected: boolean;
};

export type ChannexChannelLifecycleWebhookRegistrationTransport = {
  readonly apiOrigin: string;
  listAllWebhooks(): Promise<readonly ChannexWebhookSnapshot[]>;
  putWebhook(
    webhookId: string,
    payload: ChannexChannelLifecycleWebhookWritePayload
  ): Promise<void>;
  getWebhook(webhookId: string): Promise<ChannexWebhookSnapshot>;
};

export class ChannexChannelLifecycleWebhookRegistrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChannexChannelLifecycleWebhookRegistrationError";
  }
}

type RegistrationChange =
  | "EVENT_MASK"
  | "SECRET_HEADER"
  | "ACTIVATION"
  | "SEND_DATA";

export type ChannexChannelLifecycleWebhookRegistrationPlan = {
  action: "UPDATE_EXISTING";
  webhookId: string;
  alreadyMatches: boolean;
  changes: readonly RegistrationChange[];
  eventMask: string;
};

export type ChannexChannelLifecycleWebhookRegistrationResult =
  | {
      status: "DISABLED";
      mode: "PLAN" | "APPLY";
      reason: string;
    }
  | {
      status: "PLANNED";
      mode: "PLAN";
      webhookId: string;
      alreadyMatches: boolean;
      changes: readonly RegistrationChange[];
      eventMask: string;
    }
  | {
      status: "UPDATED_AND_VERIFIED";
      mode: "APPLY";
      webhookId: string;
      eventMask: string;
      sendData: true;
      isActive: true;
    }
  | {
      status: "UNCHANGED_AND_VERIFIED";
      mode: "APPLY";
      webhookId: string;
      eventMask: string;
      sendData: true;
      isActive: true;
    };

function fail(code: string): never {
  throw new ChannexChannelLifecycleWebhookRegistrationError(code);
}

function comparableCallback(value: unknown): string | null {
  try {
    return normalizeOtaChannelLifecycleWebhookCallbackUrl(value);
  } catch {
    return null;
  }
}

function timingSafeSecretEqual(left: unknown, right: unknown): boolean {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function hasExpectedSecret(
  headers: Readonly<Record<string, string>> | null,
  webhookSecret: string
): boolean {
  if (!headers) return false;
  const received =
    headers[OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER] ??
    Object.entries(headers).find(
      ([name]) =>
        name.toLowerCase() ===
        OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER.toLowerCase()
    )?.[1];
  return timingSafeSecretEqual(received, webhookSecret);
}

function validateCandidateMask(value: unknown): void {
  try {
    parseOtaChannelLifecycleEventMask(value);
  } catch (error) {
    if (error instanceof ChannexChannelLifecycleWebhookContractError) {
      fail(error.code);
    }
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_INVALID");
  }
}

export function planChannexChannelLifecycleWebhookRegistration(args: {
  webhooks: readonly ChannexWebhookSnapshot[];
  externalPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
}): ChannexChannelLifecycleWebhookRegistrationPlan {
  const externalPropertyId = normalizeChannexUuid(args.externalPropertyId);
  if (!externalPropertyId) {
    fail("OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED");
  }
  const callbackUrl = normalizeOtaChannelLifecycleWebhookCallbackUrl(
    args.callbackUrl
  );

  const candidates = args.webhooks.filter(
    (webhook) =>
      normalizeChannexUuid(webhook.propertyId) === externalPropertyId &&
      comparableCallback(webhook.callbackUrl) === callbackUrl
  );
  if (candidates.length === 0) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_CANDIDATE_NOT_FOUND");
  }
  if (candidates.length !== 1) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_CANDIDATE_AMBIGUOUS");
  }

  const candidate = candidates[0]!;
  const webhookId = normalizeChannexUuid(candidate.id);
  if (!webhookId) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_ID_INVALID");
  }
  if (
    candidate.isGlobal ||
    normalizeChannexUuid(candidate.propertyId) !== externalPropertyId
  ) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_SCOPE_MISMATCH");
  }
  if (candidate.isProtected) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_PROTECTED");
  }

  validateCandidateMask(candidate.eventMask);

  const changes: RegistrationChange[] = [];
  if (!hasCompleteOtaChannelLifecycleEventMask(candidate.eventMask)) {
    changes.push("EVENT_MASK");
  }
  if (!hasExpectedSecret(candidate.headers, args.webhookSecret)) {
    changes.push("SECRET_HEADER");
  }
  if (!candidate.isActive) changes.push("ACTIVATION");
  if (!candidate.sendData) changes.push("SEND_DATA");

  return {
    action: "UPDATE_EXISTING",
    webhookId,
    alreadyMatches: changes.length === 0,
    changes,
    eventMask: OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
  };
}

export function assertVerifiedChannexChannelLifecycleWebhook(args: {
  webhook: ChannexWebhookSnapshot;
  webhookId: string;
  externalPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
}): void {
  const webhookId = normalizeChannexUuid(args.webhookId);
  const externalPropertyId = normalizeChannexUuid(args.externalPropertyId);
  if (!webhookId) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_ID_INVALID");
  }
  if (!externalPropertyId) {
    fail("OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED");
  }
  const verifiedWebhookId = normalizeChannexUuid(args.webhook.id);
  if (!verifiedWebhookId) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_ID_INVALID");
  }
  if (verifiedWebhookId !== webhookId) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_ID_MISMATCH");
  }
  if (
    normalizeChannexUuid(args.webhook.propertyId) !== externalPropertyId ||
    args.webhook.isGlobal
  ) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SCOPE_MISMATCH");
  }
  if (
    comparableCallback(args.webhook.callbackUrl) !==
    normalizeOtaChannelLifecycleWebhookCallbackUrl(args.callbackUrl)
  ) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_CALLBACK_MISMATCH");
  }
  try {
    if (!hasCompleteOtaChannelLifecycleEventMask(args.webhook.eventMask)) {
      fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_EVENT_MASK_MISMATCH");
    }
  } catch {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_EVENT_MASK_MISMATCH");
  }
  if (!args.webhook.isActive) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_INACTIVE");
  }
  if (!args.webhook.sendData) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SEND_DATA_DISABLED");
  }
  if (args.webhook.isProtected) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_PROTECTED");
  }
  if (!hasExpectedSecret(args.webhook.headers, args.webhookSecret)) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_VERIFICATION_SECRET_MISMATCH");
  }
}

export async function executeChannexChannelLifecycleWebhookRegistration(args: {
  config: OtaChannelLifecycleWebhookRegistrationConfig;
  transport: ChannexChannelLifecycleWebhookRegistrationTransport;
}): Promise<ChannexChannelLifecycleWebhookRegistrationResult> {
  if (!args.config.enabled) {
    return {
      status: "DISABLED",
      mode: args.config.mode,
      reason: args.config.reason,
    };
  }
  if (args.transport.apiOrigin !== args.config.apiOrigin) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_TRANSPORT_ORIGIN_MISMATCH");
  }
  if (args.config.apiOrigin !== CHANNEX_STAGING_API_ORIGIN) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_STAGING_REQUIRED");
  }
  const externalPropertyId = normalizeChannexUuid(
    args.config.externalPropertyId
  );
  if (!externalPropertyId) {
    fail("OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED");
  }
  const normalizedCallbackUrl =
    normalizeOtaChannelLifecycleWebhookCallbackUrl(args.config.callbackUrl);
  if (
    new URL(normalizedCallbackUrl).origin !== args.config.callbackAllowedOrigin
  ) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_ORIGIN_NOT_ALLOWED");
  }
  if (
    args.config.mode === "APPLY" &&
    (args.config.apiOrigin !== CHANNEX_STAGING_API_ORIGIN ||
      args.config.applyConfirmation !==
        buildOtaChannelLifecycleRegistrationApplyConfirmation(
          externalPropertyId,
          normalizedCallbackUrl
        ))
  ) {
    fail("OTA_CHANNEL_LIFECYCLE_WEBHOOK_APPLY_AUTHORIZATION_INVALID");
  }

  const webhooks = await args.transport.listAllWebhooks();
  const plan = planChannexChannelLifecycleWebhookRegistration({
    webhooks,
    externalPropertyId,
    callbackUrl: normalizedCallbackUrl,
    webhookSecret: args.config.webhookSecret,
  });

  if (args.config.mode === "PLAN") {
    return {
      status: "PLANNED",
      mode: "PLAN",
      webhookId: plan.webhookId,
      alreadyMatches: plan.alreadyMatches,
      changes: plan.changes,
      eventMask: plan.eventMask,
    };
  }

  if (!plan.alreadyMatches) {
    const payload = buildChannexChannelLifecycleWebhookPayload({
      externalPropertyId,
      callbackUrl: normalizedCallbackUrl,
      webhookSecret: args.config.webhookSecret,
    });
    await args.transport.putWebhook(plan.webhookId, payload);
  }
  const verification = await args.transport.getWebhook(plan.webhookId);
  assertVerifiedChannexChannelLifecycleWebhook({
    webhook: verification,
    webhookId: plan.webhookId,
    externalPropertyId,
    callbackUrl: normalizedCallbackUrl,
    webhookSecret: args.config.webhookSecret,
  });

  return {
    status: plan.alreadyMatches
      ? "UNCHANGED_AND_VERIFIED"
      : "UPDATED_AND_VERIFIED",
    mode: "APPLY",
    webhookId: plan.webhookId,
    eventMask: OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
    sendData: true,
    isActive: true,
  };
}
