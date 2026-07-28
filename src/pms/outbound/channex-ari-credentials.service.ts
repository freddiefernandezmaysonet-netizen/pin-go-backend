import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";

export const CHANNEX_ARI_GLOBAL_CONNECTION_TYPE = "WHITE_LABEL_GLOBAL";
export const CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER = "PinGo";

export type ChannexAriCredentialSource =
  | "CONNECTION_ENCRYPTED_JSON"
  | "CONNECTION_ENCRYPTED_LEGACY"
  | "GLOBAL_MANAGED";

export type ChannexAriCredentialsDb = Pick<
  Prisma.TransactionClient,
  "pmsConnection"
>;

export type ResolveChannexAriCredentialsInput = {
  connectionId: string;
  organizationId: string;
  credentialsSecret?: string;
  globalApiKey?: string;
};

type UnknownRecord = Record<string, unknown>;

type ChannexAriCredentialEvidence = {
  connectionId: string;
  organizationId: string;
  source: ChannexAriCredentialSource;
  connectionType: string | null;
  managedBy: string | null;
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function requireText(value: unknown, errorCode: string): string {
  const normalized = asText(value);

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeApiKey(value: unknown, errorCode: string): string {
  const apiKey = requireText(value, errorCode);

  if (apiKey.length > 4_096) {
    throw new Error("CHANNEX_ARI_CREDENTIAL_API_KEY_INVALID");
  }

  return apiKey;
}

function resolveConfiguredValue(input: {
  supplied: string | undefined;
  environmentName: "PMS_CREDENTIALS_SECRET" | "CHANNEX_API_KEY";
}): string | null {
  const value =
    input.supplied !== undefined
      ? input.supplied
      : process.env[input.environmentName];

  return asText(value);
}

function getEncryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function decodeBase64(input: {
  value: unknown;
  errorCode: string;
  expectedBytes?: number;
  minimumBytes?: number;
}): Buffer {
  const encoded = requireText(input.value, input.errorCode);

  if (
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error(input.errorCode);
  }

  const decoded = Buffer.from(encoded, "base64");

  if (
    decoded.length === 0 ||
    (input.expectedBytes !== undefined &&
      decoded.length !== input.expectedBytes) ||
    (input.minimumBytes !== undefined && decoded.length < input.minimumBytes)
  ) {
    throw new Error(input.errorCode);
  }

  if (decoded.toString("base64") !== encoded) {
    throw new Error(input.errorCode);
  }

  return decoded;
}

function decryptAesGcm(input: {
  key: Buffer;
  iv: Buffer;
  tag: Buffer;
  encrypted: Buffer;
}): UnknownRecord {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      input.key,
      input.iv
    );
    decipher.setAuthTag(input.tag);

    const plaintext = Buffer.concat([
      decipher.update(input.encrypted),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    const record = asRecord(parsed);

    if (!record) {
      throw new Error("INVALID_PLAINTEXT");
    }

    return record;
  } catch {
    throw new Error("CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID");
  }
}

function decryptJsonEnvelope(input: {
  encryptedValue: string;
  key: Buffer;
}): UnknownRecord {
  let envelope: UnknownRecord;

  try {
    const parsed = JSON.parse(input.encryptedValue);
    const record = asRecord(parsed);

    if (!record) throw new Error("INVALID_ENVELOPE");
    envelope = record;
  } catch {
    throw new Error("CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID");
  }

  if (envelope.alg !== "aes-256-gcm") {
    throw new Error("CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID");
  }

  return decryptAesGcm({
    key: input.key,
    iv: decodeBase64({
      value: envelope.iv,
      errorCode: "CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID",
      expectedBytes: 12,
    }),
    tag: decodeBase64({
      value: envelope.tag,
      errorCode: "CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID",
      expectedBytes: 16,
    }),
    encrypted: decodeBase64({
      value: envelope.data,
      errorCode: "CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID",
      minimumBytes: 1,
    }),
  });
}

function decryptLegacyPackedValue(input: {
  encryptedValue: string;
  key: Buffer;
}): UnknownRecord {
  const packed = decodeBase64({
    value: input.encryptedValue,
    errorCode: "CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID",
    minimumBytes: 29,
  });

  return decryptAesGcm({
    key: input.key,
    iv: packed.subarray(0, 12),
    tag: packed.subarray(12, 28),
    encrypted: packed.subarray(28),
  });
}

function decryptConnectionCredentials(input: {
  encryptedValue: string;
  secret: string;
}): {
  credentials: UnknownRecord;
  source: Extract<
    ChannexAriCredentialSource,
    "CONNECTION_ENCRYPTED_JSON" | "CONNECTION_ENCRYPTED_LEGACY"
  >;
} {
  const encryptedValue = requireText(
    input.encryptedValue,
    "CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID"
  );
  const key = getEncryptionKey(input.secret);

  if (encryptedValue.startsWith("{")) {
    return {
      credentials: decryptJsonEnvelope({ encryptedValue, key }),
      source: "CONNECTION_ENCRYPTED_JSON",
    };
  }

  return {
    credentials: decryptLegacyPackedValue({ encryptedValue, key }),
    source: "CONNECTION_ENCRYPTED_LEGACY",
  };
}

function readConnectionMetadata(value: Prisma.JsonValue | null): {
  connectionType: string | null;
  managedBy: string | null;
} {
  if (value == null) {
    return { connectionType: null, managedBy: null };
  }

  const metadata = asRecord(value);

  if (!metadata) {
    throw new Error("CHANNEX_ARI_CONNECTION_METADATA_INVALID");
  }

  return {
    connectionType: asText(metadata.connectionType),
    managedBy: asText(metadata.managedBy),
  };
}

function buildResult(input: {
  apiKey: string;
  source: ChannexAriCredentialSource;
  connectionId: string;
  organizationId: string;
  connectionType: string | null;
  managedBy: string | null;
}): {
  apiKey: string;
  evidence: ChannexAriCredentialEvidence;
} {
  return {
    apiKey: input.apiKey,
    evidence: {
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      source: input.source,
      connectionType: input.connectionType,
      managedBy: input.managedBy,
    },
  };
}

export async function resolveChannexAriCredentials(
  db: ChannexAriCredentialsDb,
  input: ResolveChannexAriCredentialsInput
) {
  const connectionId = requireText(
    input.connectionId,
    "CHANNEX_ARI_CREDENTIAL_CONNECTION_ID_REQUIRED"
  );
  const organizationId = requireText(
    input.organizationId,
    "CHANNEX_ARI_CREDENTIAL_ORGANIZATION_ID_REQUIRED"
  );
  const connection = await db.pmsConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      organizationId: true,
      provider: true,
      status: true,
      credentialsEncrypted: true,
      metadata: true,
    },
  });

  if (!connection) {
    throw new Error("CHANNEX_ARI_CREDENTIAL_CONNECTION_NOT_FOUND");
  }

  if (connection.organizationId !== organizationId) {
    throw new Error("CHANNEX_ARI_CREDENTIAL_ORGANIZATION_MISMATCH");
  }

  if (connection.provider !== "CHANNEX") {
    throw new Error("CHANNEX_ARI_CREDENTIAL_PROVIDER_MISMATCH");
  }

  if (connection.status !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_CREDENTIAL_CONNECTION_NOT_ACTIVE");
  }

  const metadata = readConnectionMetadata(connection.metadata);

  if (connection.credentialsEncrypted) {
    const secret = resolveConfiguredValue({
      supplied: input.credentialsSecret,
      environmentName: "PMS_CREDENTIALS_SECRET",
    });

    if (!secret) {
      throw new Error("CHANNEX_ARI_CREDENTIALS_SECRET_REQUIRED");
    }

    const decrypted = decryptConnectionCredentials({
      encryptedValue: connection.credentialsEncrypted,
      secret,
    });
    const apiKey = normalizeApiKey(
      decrypted.credentials.apiKey,
      "CHANNEX_ARI_CREDENTIAL_API_KEY_MISSING"
    );

    return buildResult({
      apiKey,
      source: decrypted.source,
      connectionId: connection.id,
      organizationId: connection.organizationId,
      connectionType: metadata.connectionType,
      managedBy: metadata.managedBy,
    });
  }

  if (
    metadata.connectionType !== CHANNEX_ARI_GLOBAL_CONNECTION_TYPE ||
    metadata.managedBy !== CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER
  ) {
    throw new Error("CHANNEX_ARI_GLOBAL_CONNECTION_CONTRACT_INVALID");
  }

  const globalApiKey = resolveConfiguredValue({
    supplied: input.globalApiKey,
    environmentName: "CHANNEX_API_KEY",
  });

  if (!globalApiKey) {
    throw new Error("CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED");
  }

  return buildResult({
    apiKey: normalizeApiKey(
      globalApiKey,
      "CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED"
    ),
    source: "GLOBAL_MANAGED",
    connectionId: connection.id,
    organizationId: connection.organizationId,
    connectionType: metadata.connectionType,
    managedBy: metadata.managedBy,
  });
}
