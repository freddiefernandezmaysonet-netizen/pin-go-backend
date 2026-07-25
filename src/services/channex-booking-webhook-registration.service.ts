import axios from "axios";
import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  CHANNEX_WEBHOOK_SECRET_HEADER,
  generateChannexWebhookSecret,
} from "../pms/ingest/channex-webhook-auth";

const CHANNEX_WEBHOOK_EVENT_MASK = "booking";
const CHANNEX_WEBHOOK_SEND_DATA = false;
const CHANNEX_REQUEST_TIMEOUT_MS = 20_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeChannexStagingBaseUrl(value: string) {
  const url = new URL(String(value ?? "").trim());

  if (url.protocol !== "https:" || url.hostname !== "staging.channex.io") {
    throw new Error("CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING");
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeChannexWebhookCallbackUrl(value: string) {
  const url = new URL(String(value ?? "").trim());

  if (url.protocol !== "https:") {
    throw new Error("CHANNEX_WEBHOOK_CALLBACK_REQUIRES_HTTPS");
  }

  if (!url.pathname.endsWith("/webhooks/channex")) {
    throw new Error("CHANNEX_WEBHOOK_CALLBACK_PATH_INVALID");
  }

  return url.toString().replace(/\/+$/, "");
}

export function buildChannexBookingWebhookPayload(args: {
  channexPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
}) {
  return {
    webhook: {
      property_id: args.channexPropertyId,
      callback_url: args.callbackUrl,
      event_mask: CHANNEX_WEBHOOK_EVENT_MASK,
      headers: {
        [CHANNEX_WEBHOOK_SECRET_HEADER]: args.webhookSecret,
      },
      is_active: true,
      send_data: CHANNEX_WEBHOOK_SEND_DATA,
    },
  };
}

function getChannexWebhookId(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  return asString(data.id) ?? asString(root.id);
}

function getChannexWebhookAttributes(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  return asRecord(data.attributes ?? root.attributes);
}

function assertVerifiedWebhook(args: {
  responseData: unknown;
  callbackUrl: string;
  channexPropertyId: string;
}) {
  const attributes = getChannexWebhookAttributes(args.responseData);
  const callbackUrl = asString(attributes.callback_url);
  const propertyId = asString(attributes.property_id);
  const eventMask = asString(attributes.event_mask);
  const isActive = attributes.is_active;
  const sendData = attributes.send_data;

  if (callbackUrl && callbackUrl !== args.callbackUrl) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_CALLBACK_MISMATCH");
  }

  if (propertyId && propertyId !== args.channexPropertyId) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_PROPERTY_MISMATCH");
  }

  if (eventMask && eventMask !== CHANNEX_WEBHOOK_EVENT_MASK) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_EVENT_MASK_MISMATCH");
  }

  if (isActive === false) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_INACTIVE");
  }

  if (sendData === true) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_SEND_DATA_ENABLED");
  }
}

export async function configureChannexBookingWebhookForStaging(args: {
  propertyId: string;
  callbackUrl: string;
  apiKey: string;
  apiBaseUrl: string;
}) {
  const propertyId = String(args.propertyId ?? "").trim();
  const apiKey = String(args.apiKey ?? "").trim();

  if (!propertyId) {
    throw new Error("PIN_GO_PROPERTY_ID_REQUIRED");
  }

  if (!apiKey) {
    throw new Error("CHANNEX_API_KEY_REQUIRED");
  }

  const apiBaseUrl = normalizeChannexStagingBaseUrl(args.apiBaseUrl);
  const callbackUrl = normalizeChannexWebhookCallbackUrl(args.callbackUrl);

  const listings = await prisma.pmsListing.findMany({
    where: {
      propertyId,
      connection: {
        is: {
          provider: PmsProvider.CHANNEX,
          status: "ACTIVE",
        },
      },
    },
    include: {
      connection: {
        select: {
          id: true,
          webhookSecret: true,
        },
      },
    },
    take: 2,
  });

  if (listings.length === 0) {
    throw new Error("CHANNEX_PROPERTY_MAPPING_NOT_FOUND");
  }

  if (listings.length > 1) {
    throw new Error("CHANNEX_PROPERTY_MAPPING_AMBIGUOUS");
  }

  const listing = listings[0]!;
  const listingMetadata = asRecord(listing.metadata);
  const channexPropertyId = asString(listingMetadata.channexPropertyId);

  if (!channexPropertyId) {
    throw new Error("CHANNEX_PROPERTY_ID_MISSING_FROM_LISTING");
  }

  const existingWebhookId = asString(
    listingMetadata.channexBookingWebhookId
  );
  const existingSecret = asString(listing.connection.webhookSecret);
  const webhookSecret = existingSecret ?? generateChannexWebhookSecret();

  if (!existingSecret) {
    await prisma.pmsConnection.update({
      where: { id: listing.connection.id },
      data: { webhookSecret },
    });
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": apiKey,
  };
  const payload = buildChannexBookingWebhookPayload({
    channexPropertyId,
    callbackUrl,
    webhookSecret,
  });

  let webhookId = existingWebhookId;
  let operation: "CREATED" | "UPDATED" | "RECREATED";

  if (webhookId) {
    try {
      await axios.put(
        `${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
        payload,
        {
          headers,
          timeout: CHANNEX_REQUEST_TIMEOUT_MS,
        }
      );
      operation = "UPDATED";
    } catch (error: any) {
      if (error?.response?.status !== 404) {
        throw error;
      }

      webhookId = null;
      operation = "RECREATED";
    }
  } else {
    operation = "CREATED";
  }

  if (!webhookId) {
    const response = await axios.post(
      `${apiBaseUrl}/api/v1/webhooks`,
      payload,
      {
        headers,
        timeout: CHANNEX_REQUEST_TIMEOUT_MS,
      }
    );

    webhookId = getChannexWebhookId(response.data);

    if (!webhookId) {
      throw new Error("CHANNEX_WEBHOOK_CREATE_RESPONSE_INVALID");
    }
  }

  const verification = await axios.get(
    `${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
    {
      headers,
      timeout: CHANNEX_REQUEST_TIMEOUT_MS,
    }
  );

  assertVerifiedWebhook({
    responseData: verification.data,
    callbackUrl,
    channexPropertyId,
  });

  await prisma.pmsListing.update({
    where: { id: listing.id },
    data: {
      metadata: {
        ...listingMetadata,
        channexBookingWebhookId: webhookId,
        channexBookingWebhookEventMask: CHANNEX_WEBHOOK_EVENT_MASK,
        channexBookingWebhookSendData: CHANNEX_WEBHOOK_SEND_DATA,
        channexBookingWebhookCallbackUrl: callbackUrl,
        channexBookingWebhookConfiguredAt: new Date().toISOString(),
      },
    },
  });

  return {
    ok: true,
    provider: "PIN_GO_CONNECT",
    environment: "STAGING",
    operation,
    propertyId,
    channexPropertyId,
    webhookId,
    callbackUrl,
    eventMask: CHANNEX_WEBHOOK_EVENT_MASK,
    sendData: CHANNEX_WEBHOOK_SEND_DATA,
    isActive: true,
    secretCreated: !existingSecret,
    verified: true,
  };
}
