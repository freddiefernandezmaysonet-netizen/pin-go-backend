import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

export type OtaConnectionSessionStatus =
  | "REQUESTED"
  | "TOKEN_ISSUED"
  | "OPENED"
  | "COMPLETED"
  | "EXPIRED"
  | "FAILED"
  | "CANCELLED";

type SessionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: ConnectionCenterProvider;
  status: OtaConnectionSessionStatus;
  expiresAt: Date;
};

type ConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  provider: ConnectionCenterProvider;
  distributionProperty: {
    organizationId: string;
    propertyId: string;
    provisioningStatus: string;
    externalPropertyId: string | null;
    group: {
      organizationId: string;
      provisioningStatus: string;
      externalGroupId: string | null;
    } | null;
  };
};

export type OtaConnectionSessionClient = {
  dashboardUser: { findFirst(args: any): Promise<{ id: string } | null> };
  property: { findFirst(args: any): Promise<{ id: string } | null> };
  otaChannelConnection: { findFirst(args: any): Promise<ConnectionRecord | null> };
  otaConnectionSession: {
    findUnique(args: any): Promise<SessionRecord | null>;
    create(args: any): Promise<SessionRecord>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  apmsAuditEntry: { create(args: any): Promise<unknown> };
};

export type OneTimeConnectionTokenIssuer = {
  issue(args: {
    externalGroupId: string;
    externalPropertyId: string;
    provider: ConnectionCenterProvider;
  }): Promise<{ token: string; launchUrl: string }>;
};

export class OtaConnectionSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OtaConnectionSessionError";
  }
}

function required(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 120) throw new OtaConnectionSessionError(code);
  return normalized;
}

function safeOrigin(rawUrl: string, allowedOrigins: ReadonlySet<string>): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OtaConnectionSessionError("OTA_CONNECTION_LAUNCH_URL_INVALID");
  }
  if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_LAUNCH_ORIGIN_FORBIDDEN");
  }
  if (url.origin.length > 255) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_LAUNCH_URL_INVALID");
  }
  return url.origin;
}

async function verifyScope(args: {
  client: OtaConnectionSessionClient;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
}): Promise<void> {
  const [actor, property] = await Promise.all([
    args.client.dashboardUser.findFirst({
      where: {
        id: args.requestedByUserId,
        organizationId: args.organizationId,
        isActive: true,
      },
      select: { id: true },
    }),
    args.client.property.findFirst({
      where: {
        id: args.propertyId,
        organizationId: args.organizationId,
        status: "ACTIVE",
      },
      select: { id: true },
    }),
  ]);
  if (!actor) throw new OtaConnectionSessionError("OTA_CONNECTION_ACTOR_FORBIDDEN");
  if (!property) throw new OtaConnectionSessionError("OTA_CONNECTION_PROPERTY_NOT_FOUND");
}

async function auditSessionEvent(args: {
  client: OtaConnectionSessionClient;
  session: SessionRecord;
  event: string;
  status: "SUCCESS" | "FAILED";
  now: Date;
  errorCode?: string;
}): Promise<void> {
  await args.client.apmsAuditEntry.create({
    data: {
      organizationId: args.session.organizationId,
      propertyId: args.session.propertyId,
      entityType: "DISTRIBUTION",
      entityId: args.session.id,
      engine: "OTA_DISTRIBUTION",
      eventType: args.status === "SUCCESS" ? "ACTION_COMPLETED" : "ACTION_FAILED",
      status: args.status,
      severity: args.status === "SUCCESS" ? "INFO" : "WARNING",
      decisionId: `ota-connection-session:${args.session.id}:${args.event}`,
      summary: `OTA connection session ${args.event.toLowerCase()}`,
      reason: args.errorCode ?? args.event,
      metadata: {
        provider: args.session.provider,
        requestedByUserId: args.session.requestedByUserId,
      },
      startedAt: args.now,
      completedAt: args.now,
      durationMs: 0,
    },
  });
}

export async function issueOtaConnectionSession(args: {
  client: OtaConnectionSessionClient;
  issuer: OneTimeConnectionTokenIssuer;
  allowedLaunchOrigins: ReadonlySet<string>;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: ConnectionCenterProvider;
  requestKey: string;
  now?: Date;
  ttlMs?: number;
}): Promise<{ sessionId: string; token: string; launchUrl: string; expiresAt: Date }> {
  const organizationId = required(args.organizationId, "OTA_CONNECTION_ORGANIZATION_REQUIRED");
  const propertyId = required(args.propertyId, "OTA_CONNECTION_PROPERTY_REQUIRED");
  const requestedByUserId = required(args.requestedByUserId, "OTA_CONNECTION_ACTOR_REQUIRED");
  const requestKey = required(args.requestKey, "OTA_CONNECTION_REQUEST_KEY_INVALID");
  if (!/^[A-Za-z0-9._:-]+$/.test(requestKey)) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_REQUEST_KEY_INVALID");
  }
  if (args.provider !== "AIRBNB" && args.provider !== "BOOKING_COM") {
    throw new OtaConnectionSessionError("OTA_CONNECTION_PROVIDER_UNAVAILABLE");
  }
  await verifyScope({ client: args.client, organizationId, propertyId, requestedByUserId });

  const connection = await args.client.otaChannelConnection.findFirst({
    where: { organizationId, propertyId, provider: args.provider },
    include: { distributionProperty: { include: { group: true } } },
  });
  if (!connection) throw new OtaConnectionSessionError("OTA_CONNECTION_NOT_PREPARED");
  const distributionProperty = connection.distributionProperty;
  const group = distributionProperty.group;
  if (
    connection.organizationId !== organizationId ||
    connection.propertyId !== propertyId ||
    connection.provider !== args.provider ||
    distributionProperty.organizationId !== organizationId ||
    distributionProperty.propertyId !== propertyId ||
    !group ||
    group.organizationId !== organizationId
  ) {
    throw new OtaConnectionSessionError("OTA_DISTRIBUTION_TENANT_MISMATCH");
  }
  if (
    distributionProperty.provisioningStatus !== "READY" ||
    group.provisioningStatus !== "READY" ||
    !distributionProperty.externalPropertyId ||
    !group.externalGroupId
  ) {
    throw new OtaConnectionSessionError("DISTRIBUTION_PROVISIONING_REQUIRED");
  }

  const duplicate = await args.client.otaConnectionSession.findUnique({
    where: { organizationId_requestKey: { organizationId, requestKey } },
  });
  if (duplicate) throw new OtaConnectionSessionError("OTA_CONNECTION_REQUEST_ALREADY_USED");

  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? 10 * 60_000;
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_SESSION_TTL_INVALID");
  }
  const expiresAt = new Date(now.getTime() + ttlMs);
  const session = await args.client.otaConnectionSession.create({
    data: {
      organizationId,
      propertyId,
      otaChannelConnectionId: connection.id,
      requestedByUserId,
      provider: args.provider,
      status: "REQUESTED",
      requestKey,
      expiresAt,
    },
  });

  let issued: { token: string; launchUrl: string };
  let token: string;
  let launchUrlOrigin: string;
  try {
    issued = await args.issuer.issue({
      externalGroupId: group.externalGroupId,
      externalPropertyId: distributionProperty.externalPropertyId,
      provider: args.provider,
    });
    token = String(issued.token ?? "").trim();
    if (!token || token.length > 4096) {
      throw new OtaConnectionSessionError("OTA_CONNECTION_TOKEN_INVALID");
    }
    launchUrlOrigin = safeOrigin(issued.launchUrl, args.allowedLaunchOrigins);
  } catch (error) {
    const errorCode =
      error instanceof OtaConnectionSessionError
        ? error.code
        : "OTA_CONNECTION_TOKEN_ISSUER_FAILED";
    await args.client.otaConnectionSession.updateMany({
      where: { id: session.id, organizationId, status: "REQUESTED" },
      data: { status: "FAILED", failedAt: now, lastErrorCode: errorCode },
    });
    await auditSessionEvent({ client: args.client, session, event: "TOKEN_FAILED", status: "FAILED", now, errorCode });
    throw new OtaConnectionSessionError(errorCode);
  }

  const tokenFingerprint = createHash("sha256").update(token).digest("hex");
  const updated = await args.client.otaConnectionSession.updateMany({
    where: { id: session.id, organizationId, status: "REQUESTED" },
    data: { status: "TOKEN_ISSUED", tokenFingerprint, launchUrlOrigin, tokenIssuedAt: now },
  });
  if (updated.count !== 1) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_SESSION_STATE_CONFLICT");
  }
  await auditSessionEvent({
    client: args.client,
    session: { ...session, status: "TOKEN_ISSUED" },
    event: "TOKEN_ISSUED",
    status: "SUCCESS",
    now,
  });
  return { sessionId: session.id, token, launchUrl: issued.launchUrl, expiresAt };
}

export async function transitionOtaConnectionSession(args: {
  client: OtaConnectionSessionClient;
  organizationId: string;
  requestedByUserId: string;
  sessionId: string;
  current: "TOKEN_ISSUED" | "OPENED" | "REQUESTED";
  next: "OPENED" | "COMPLETED" | "CANCELLED";
  now?: Date;
}): Promise<void> {
  const allowed =
    (args.current === "TOKEN_ISSUED" && args.next === "OPENED") ||
    (args.current === "OPENED" && args.next === "COMPLETED") ||
    ((args.current === "REQUESTED" || args.current === "TOKEN_ISSUED" || args.current === "OPENED") &&
      args.next === "CANCELLED");
  if (!allowed) throw new OtaConnectionSessionError("OTA_CONNECTION_SESSION_TRANSITION_INVALID");
  const now = args.now ?? new Date();
  const timestamp =
    args.next === "OPENED"
      ? { openedAt: now }
      : args.next === "COMPLETED"
        ? { completedAt: now }
        : { cancelledAt: now };
  const result = await args.client.otaConnectionSession.updateMany({
    where: {
      id: required(args.sessionId, "OTA_CONNECTION_SESSION_REQUIRED"),
      organizationId: required(args.organizationId, "OTA_CONNECTION_ORGANIZATION_REQUIRED"),
      requestedByUserId: required(args.requestedByUserId, "OTA_CONNECTION_ACTOR_REQUIRED"),
      status: args.current,
      ...(args.current === "OPENED" ? {} : { expiresAt: { gt: now } }),
    },
    data: { status: args.next, ...timestamp },
  });
  if (result.count !== 1) {
    throw new OtaConnectionSessionError("OTA_CONNECTION_SESSION_STATE_CONFLICT");
  }
}

export async function expireUnopenedOtaConnectionSessions(args: {
  client: OtaConnectionSessionClient;
  now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  const result = await args.client.otaConnectionSession.updateMany({
    where: {
      status: { in: ["REQUESTED", "TOKEN_ISSUED"] },
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });
  return result.count;
}
