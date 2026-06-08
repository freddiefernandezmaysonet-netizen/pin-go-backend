import crypto from "crypto";
import axios from "axios";
import { PrismaClient, PmsProvider } from "@prisma/client";

const prisma = new PrismaClient();

const CHANNEX_API_BASE_URL =
  process.env.CHANNEX_API_BASE_URL ?? "https://staging.channex.io";

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) {
    throw new Error("PMS_CREDENTIALS_SECRET not configured");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function decryptJson(payload: string) {
  const parsed = JSON.parse(payload ?? "{}");

  if (
    !parsed ||
    parsed.alg !== "aes-256-gcm" ||
    !parsed.iv ||
    !parsed.tag ||
    !parsed.data
  ) {
    throw new Error("INVALID_ENCRYPTED_PMS_CREDENTIALS");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decrypted);
}

function getChannexApiKey() {
  const apiKey = String(process.env.CHANNEX_API_KEY ?? "").trim();

  if (!apiKey) {
    throw new Error("CHANNEX_API_KEY_MISSING");
  }

  return apiKey;
}
async function createChannexProperty(args: {
  apiKey: string;
  payload: Record<string, unknown>;
}) {
  const resp = await axios.post(
    `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/properties`,
    {
      property: args.payload,
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "user-api-key": args.apiKey,
      },
      timeout: 20000,
    }
  );

  const channexPropertyId =
    resp.data?.data?.id ??
    resp.data?.id ??
    null;

  if (!channexPropertyId) {
    throw new Error("CHANNEX_PROPERTY_CREATE_RESPONSE_INVALID");
  }

  return {
    channexPropertyId: String(channexPropertyId),
    raw: resp.data,
  };
}

async function createChannexRoomType(args: {
  apiKey: string;
  channexPropertyId: string;
  payload: Record<string, unknown>;
}) {
  const resp = await axios.post(
    `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/room_types`,
    {
      room_type: {
        property_id: args.channexPropertyId,
        ...args.payload,
      },
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "user-api-key": args.apiKey,
      },
      timeout: 20000,
    }
  );

  const channexRoomTypeId =
    resp.data?.data?.id ??
    resp.data?.id ??
    null;

  if (!channexRoomTypeId) {
    throw new Error("CHANNEX_ROOM_TYPE_CREATE_RESPONSE_INVALID");
  }

  return {
    channexRoomTypeId: String(channexRoomTypeId),
    raw: resp.data,
  };
}

async function createChannexRatePlan(args: {
  apiKey: string;
  channexPropertyId: string;
  channexRoomTypeId: string;
  payload: Record<string, unknown>;
}) {
  try {
    const resp = await axios.post(
      `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/rate_plans`,
      {
        rate_plan: {
          property_id: args.channexPropertyId,
          room_type_id: args.channexRoomTypeId,
          ...args.payload,
        },
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-api-key": args.apiKey,
        },
        timeout: 20000,
      }
    );

    const channexRatePlanId =
      resp.data?.data?.id ??
      resp.data?.id ??
      null;

    if (!channexRatePlanId) {
      throw new Error("CHANNEX_RATE_PLAN_CREATE_RESPONSE_INVALID");
    }

    return {
      channexRatePlanId: String(channexRatePlanId),
      raw: resp.data,
    };
  } catch (err: any) {
    console.error("[channex][create_rate_plan][failed]", {
      status: err?.response?.status ?? null,
      data: err?.response?.data ?? null,
      payload: {
        property_id: args.channexPropertyId,
        room_type_id: args.channexRoomTypeId,
        ...args.payload,
      },
      message: err?.message,
    });

    throw new Error(
      `CHANNEX_CREATE_RATE_PLAN_FAILED: ${JSON.stringify(
        err?.response?.data ?? err?.message
      )}`
    );
  }
}
export async function provisionChannexProperty(propertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const connection = await prisma.pmsConnection.upsert({
  where: {
    organizationId_provider: {
      organizationId: property.organizationId,
      provider: PmsProvider.CHANNEX,
    },
  },
  create: {
    organizationId: property.organizationId,
    provider: PmsProvider.CHANNEX,
    status: "ACTIVE",
    credentialsEncrypted: null,
    webhookSecret: null,
    metadata: {
      connectionType: "WHITE_LABEL_GLOBAL",
      managedBy: "PinGo",
      createdBy: "channex-provisioning.service",
      createdAt: new Date().toISOString(),
    },
  },
  update: {
    status: "ACTIVE",
    metadata: {
      connectionType: "WHITE_LABEL_GLOBAL",
      managedBy: "PinGo",
      updatedBy: "channex-provisioning.service",
      updatedAt: new Date().toISOString(),
    },
  },
});
  const existingListing = await prisma.pmsListing.findFirst({
    where: {
      connectionId: connection.id,
      propertyId: property.id,
    },
  });

  if (existingListing) {
    return {
      ok: true,
      alreadyProvisioned: true,
      propertyId: property.id,
      listingId: existingListing.id,
    };
  }

  const apiKey = getChannexApiKey();

  const propertyPayload = {
    title: property.publicTitle ?? property.name,
    currency: "USD",
    address: property.address1,
    city: property.city,
    state: property.region,
    country:
  String(property.country ?? "").trim().toLowerCase() === "united states"
    ? "US"
    : String(property.country ?? "US").trim().toUpperCase(),
    timezone: property.timezone ?? "America/Puerto_Rico",
    latitude:
      property.latitude != null ? Number(property.latitude) : undefined,
    longitude:
      property.longitude != null ? Number(property.longitude) : undefined,
  };

  const roomTypePayload = {
    title: property.publicTitle ?? property.name,
    count_of_rooms: 1,
    occ_adults: property.maxGuests ?? 2,
    occ_children: 0,
    occ_infants: 0,
    default_occupancy: property.maxGuests ?? 2,
  };

  const ratePlanPayload = {
    title: "Standard Rate",
    rate: Number(property.baseNightlyRate ?? 0),
    min_stay: property.minimumNights,
  };

  const channexProperty = await createChannexProperty({
    apiKey,
    payload: propertyPayload,
  });

const channexRoomType = await createChannexRoomType({
  apiKey,
  channexPropertyId: channexProperty.channexPropertyId,
  payload: roomTypePayload,
});

const channexRatePlan = await createChannexRatePlan({
  apiKey,
  channexPropertyId: channexProperty.channexPropertyId,
  channexRoomTypeId: channexRoomType.channexRoomTypeId,
  payload: {
    title: "Standard Rate",
    options: [
      {
        occupancy: property.maxGuests ?? 2,
        is_primary: true,
        rate: Number(property.baseNightlyRate ?? 0),
      },
    ],
  },
});

const listing = await prisma.pmsListing.create({
  data: {
    connectionId: connection.id,
    propertyId: property.id,

    externalListingId:
      channexRoomType.channexRoomTypeId,

    name:
      property.publicTitle ??
      property.name,

    metadata: {
      provider: "CHANNEX",
      channexPropertyId:
        channexProperty.channexPropertyId,

      channexRatePlanId:
        channexRatePlan.channexRatePlanId,

      provisionedAt:
        new Date().toISOString(),
    },
  },
});

  return {
    ok: true,
    alreadyProvisioned: false,
    listingId: listing.id,
    channexPropertyId: channexProperty.channexPropertyId,
    channexRoomTypeId: channexRoomType.channexRoomTypeId,
    channexRatePlanId:
    channexRatePlan.channexRatePlanId,
    propertyPayload,
    roomTypePayload,
    ratePlanPayload,
  };
}