export const MESSAGES_APPLICATION_CODE = "channex_messages";

export type ApplicationRequest = (input: {
  method: "GET" | "POST";
  path: string;
  page?: number;
  body?: unknown;
}) => Promise<unknown>;

export type MessagesInstallation = {
  installationId: string;
  channexPropertyId: string;
  applicationCode: typeof MESSAGES_APPLICATION_CODE;
  alreadyInstalled: boolean;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CHANNEX_MESSAGES_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function installation(value: unknown, propertyId: string): string | null {
  const row = record(value);
  const attributes = record(row.attributes);
  if (attributes.property_id !== propertyId ||
      attributes.application_code !== MESSAGES_APPLICATION_CODE) return null;
  if (attributes.is_active === false) {
    throw new Error("CHANNEX_MESSAGES_INSTALLATION_INACTIVE");
  }
  if (typeof row.id !== "string" || !row.id.trim() ||
      (attributes.is_active !== undefined && attributes.is_active !== true)) {
    throw new Error("CHANNEX_MESSAGES_RESPONSE_INVALID");
  }
  return row.id;
}

async function findInstalled(propertyId: string, request: ApplicationRequest): Promise<string | null> {
  let expectedTotal: number | undefined;
  const seen = new Set<string>();
  let found: string | null = null;
  for (let page = 1; page <= 20; page++) {
    const response = record(await request({ method: "GET", path: "/api/v1/applications/installed", page }));
    if (!Array.isArray(response.data)) throw new Error("CHANNEX_MESSAGES_RESPONSE_INVALID");
    for (const value of response.data) {
      const row = record(value);
      if (typeof row.id !== "string" || !row.id.trim() || seen.has(row.id)) {
        throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
      }
      seen.add(row.id);
      const match = installation(value, propertyId);
      if (match && found) throw new Error("CHANNEX_MESSAGES_INSTALLATION_AMBIGUOUS");
      if (match) found = match;
    }
    // The documented installed-applications response has no pagination metadata.
    // If the API supplies metadata, consume and validate all pages before installing.
    if (response.meta === undefined) {
      if (page !== 1) throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
      return found;
    }
    const meta = record(response.meta);
    if (!Number.isSafeInteger(meta.total) || Number(meta.total) < 0 ||
        !Number.isSafeInteger(meta.limit) || Number(meta.limit) <= 0 || meta.page !== page) {
      throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
    }
    const total = Number(meta.total);
    if (expectedTotal !== undefined && expectedTotal !== total) {
      throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
    }
    expectedTotal = total;
    if (seen.size > total) throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
    if (seen.size === total) return found;
    if (response.data.length !== meta.limit) throw new Error("CHANNEX_MESSAGES_COLLECTION_INCONSISTENT");
  }
  throw new Error("CHANNEX_MESSAGES_COLLECTION_LIMIT");
}

export async function ensureMessagesApplication(
  channexPropertyId: string,
  request: ApplicationRequest,
): Promise<MessagesInstallation> {
  if (!channexPropertyId.trim() || channexPropertyId !== channexPropertyId.trim()) {
    throw new Error("CHANNEX_MESSAGES_PROPERTY_ID_REQUIRED");
  }
  const existing = await findInstalled(channexPropertyId, request);
  if (existing) return { installationId: existing, channexPropertyId,
    applicationCode: MESSAGES_APPLICATION_CODE, alreadyInstalled: true };
  await request({ method: "POST", path: "/api/v1/applications/install", body: {
    application_installation: { property_id: channexPropertyId,
      application_code: MESSAGES_APPLICATION_CODE },
  } });
  // A successful POST alone is insufficient evidence. A later retry checks GET first,
  // including after an uncertain POST outcome, rather than blindly replaying it.
  const verified = await findInstalled(channexPropertyId, request);
  if (!verified) throw new Error("CHANNEX_MESSAGES_INSTALLATION_NOT_VERIFIED");
  return { installationId: verified, channexPropertyId,
    applicationCode: MESSAGES_APPLICATION_CODE, alreadyInstalled: false };
}
