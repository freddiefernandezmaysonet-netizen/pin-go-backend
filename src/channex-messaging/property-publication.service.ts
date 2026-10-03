import type { PrismaClient } from "@prisma/client";
import { ensureMessagesApplication, type ApplicationRequest } from "./application-installation.js";

type PublicationScope = { propertyId: string; organizationId: string };
export type PublicationDependencies = {
  resolveMapping: (scope: PublicationScope) => Promise<string>;
  withPropertyLock: <T>(scope: PublicationScope, work: () => Promise<T>) => Promise<T>;
  createRequest: () => ApplicationRequest;
};

export async function ensurePublishedPropertyMessages(
  scope: PublicationScope,
  dependencies: PublicationDependencies,
) {
  return dependencies.withPropertyLock(scope, async () => {
    const propertyId = await dependencies.resolveMapping(scope);
    return ensureMessagesApplication(propertyId, dependencies.createRequest());
  });
}

export function createMessagesApplicationRequest(args: {
  apiOrigin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ApplicationRequest {
  if (!["https://app.channex.io", "https://staging.channex.io"].includes(args.apiOrigin) || !args.apiKey.trim()) {
    throw new Error("OTA_MESSAGES_TRANSPORT_CONFIGURATION_INVALID");
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(60000);
  return async input => {
    if (!((input.method === "GET" && input.path === "/api/v1/applications/installed") ||
      (input.method === "POST" && input.path === "/api/v1/applications/install"))) {
      throw new Error("OTA_MESSAGES_REQUEST_NOT_ALLOWED");
    }
    const url = new URL(input.path, args.apiOrigin);
    if (input.page !== undefined) {
      url.searchParams.set("pagination[page]", String(input.page));
      url.searchParams.set("pagination[limit]", "100");
    }
    try {
      const response = await fetchImpl(url, { method: input.method, redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json", "user-api-key": args.apiKey },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OTA_MESSAGES_API_HTTP_${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("OTA_MESSAGES_RESPONSE_INVALID");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 1_000_000) throw new Error("OTA_MESSAGES_RESPONSE_LIMIT");
          chunks.push(item.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^OTA_MESSAGES_(API_HTTP_\d{3}|RESPONSE_INVALID|RESPONSE_LIMIT)$/.test(message)) {
        throw new Error(message);
      }
      // No raw network/provider errors, credentials or response bodies escape.
      throw new Error("OTA_MESSAGES_API_OUTCOME_UNKNOWN");
    }
  };
}

export function createPropertyMessagesInstaller(args: {
  prisma: PrismaClient;
  apiOrigin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}) {
  const dependencies: PublicationDependencies = {
    async resolveMapping(scope) {
      const property = await args.prisma.distributionProperty.findFirst({ where: {
        organizationId: scope.organizationId, propertyId: scope.propertyId, platform: "CHANNEX",
        provisioningStatus: "READY", property: { organizationId: scope.organizationId, status: "ACTIVE" },
      }, select: { externalPropertyId: true, group: { select: {
        organizationId: true, provisioningStatus: true, externalGroupId: true,
      } } } });
      if (!property || !property.group || property.group.organizationId !== scope.organizationId ||
          property.group.provisioningStatus !== "READY" || !property.group.externalGroupId ||
          !property.externalPropertyId) throw new Error("OTA_MESSAGES_PROPERTY_MAPPING_NOT_READY");
      return property.externalPropertyId;
    },
    async withPropertyLock(scope, work) {
      return args.prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(
            ${`channex-messages-publication:${scope.propertyId}`}, 0)) AS locked`;
        if (rows[0]?.locked !== true) throw new Error("OTA_MESSAGES_INSTALLATION_BUSY");
        return work();
      }, { maxWait: 5000, timeout: 90000 });
    },
    createRequest: () => createMessagesApplicationRequest(args),
  };
  return (scope: PublicationScope) => ensurePublishedPropertyMessages(scope, dependencies);
}
