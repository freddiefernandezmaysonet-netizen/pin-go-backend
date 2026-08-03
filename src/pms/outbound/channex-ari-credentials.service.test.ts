import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER,
  CHANNEX_ARI_GLOBAL_CONNECTION_TYPE,
  resolveChannexAriCredentials,
} from "./channex-ari-credentials.service";

const SECRET = "test-pms-credentials-secret";
const CONNECTION_API_KEY = "connection-channex-api-key";
const GLOBAL_API_KEY = "global-channex-api-key";

type ConnectionRow = {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
  credentialsEncrypted: string | null;
  metadata: unknown;
};

function encryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptCredentials(input: {
  secret: string;
  credentials: Record<string, unknown>;
  format: "JSON" | "LEGACY";
}): string {
  const iv = Buffer.from(
    input.format === "JSON" ? "json-iv-0001" : "legacy-iv001",
    "utf8"
  );
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey(input.secret),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(input.credentials), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (input.format === "LEGACY") {
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  return JSON.stringify({
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "connection-1",
    organizationId: "org-1",
    provider: "CHANNEX",
    status: "ACTIVE",
    credentialsEncrypted: null,
    metadata: {
      connectionType: CHANNEX_ARI_GLOBAL_CONNECTION_TYPE,
      managedBy: CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER,
    },
    ...overrides,
  };
}

function createMockDb(row: ConnectionRow | null) {
  const calls: any[] = [];

  return {
    db: {
      pmsConnection: {
        findUnique: async (args: any) => {
          calls.push(args);
          return row ? { ...row } : null;
        },
      },
    },
    calls,
  };
}

test("decrypts the canonical JSON envelope and returns sanitized evidence", async () => {
  const encrypted = encryptCredentials({
    secret: SECRET,
    credentials: {
      apiKey: `  ${CONNECTION_API_KEY}  `,
      accountName: "Private Channex account",
    },
    format: "JSON",
  });
  const mock = createMockDb(
    connection({
      credentialsEncrypted: encrypted,
      metadata: {
        connectionType: "ORGANIZATION_MANAGED",
        managedBy: "Host",
      },
    })
  );

  const result = await resolveChannexAriCredentials(mock.db as any, {
    connectionId: " connection-1 ",
    organizationId: " org-1 ",
    credentialsSecret: SECRET,
    globalApiKey: "must-not-be-used",
  });

  assert.deepEqual(mock.calls, [
    {
      where: { id: "connection-1" },
      select: {
        id: true,
        organizationId: true,
        provider: true,
        status: true,
        credentialsEncrypted: true,
        metadata: true,
      },
    },
  ]);
  assert.deepEqual(result, {
    apiKey: CONNECTION_API_KEY,
    evidence: {
      connectionId: "connection-1",
      organizationId: "org-1",
      source: "CONNECTION_ENCRYPTED_JSON",
      connectionType: "ORGANIZATION_MANAGED",
      managedBy: "Host",
    },
  });
  assert.equal(JSON.stringify(result.evidence).includes(CONNECTION_API_KEY), false);
  assert.equal(JSON.stringify(result.evidence).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes("must-not-be-used"), false);
});

test("decrypts the supported legacy packed AES-GCM format", async () => {
  const encrypted = encryptCredentials({
    secret: SECRET,
    credentials: { apiKey: CONNECTION_API_KEY },
    format: "LEGACY",
  });
  const mock = createMockDb(
    connection({
      credentialsEncrypted: encrypted,
      metadata: null,
    })
  );

  const result = await resolveChannexAriCredentials(mock.db as any, {
    connectionId: "connection-1",
    organizationId: "org-1",
    credentialsSecret: SECRET,
  });

  assert.deepEqual(result, {
    apiKey: CONNECTION_API_KEY,
    evidence: {
      connectionId: "connection-1",
      organizationId: "org-1",
      source: "CONNECTION_ENCRYPTED_LEGACY",
      connectionType: null,
      managedBy: null,
    },
  });
});

test("resolves the global key only for an explicit PinGo-managed white-label connection", async () => {
  const mock = createMockDb(connection());

  const result = await resolveChannexAriCredentials(mock.db as any, {
    connectionId: "connection-1",
    organizationId: "org-1",
    globalApiKey: ` ${GLOBAL_API_KEY} `,
  });

  assert.deepEqual(result, {
    apiKey: GLOBAL_API_KEY,
    evidence: {
      connectionId: "connection-1",
      organizationId: "org-1",
      source: "GLOBAL_MANAGED",
      connectionType: CHANNEX_ARI_GLOBAL_CONNECTION_TYPE,
      managedBy: CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER,
    },
  });
  assert.equal(JSON.stringify(result.evidence).includes(GLOBAL_API_KEY), false);
});

test("gives encrypted connection credentials precedence over the global key", async () => {
  const encrypted = encryptCredentials({
    secret: SECRET,
    credentials: { apiKey: CONNECTION_API_KEY },
    format: "JSON",
  });
  const mock = createMockDb(
    connection({
      credentialsEncrypted: encrypted,
    })
  );

  const result = await resolveChannexAriCredentials(mock.db as any, {
    connectionId: "connection-1",
    organizationId: "org-1",
    credentialsSecret: SECRET,
    globalApiKey: GLOBAL_API_KEY,
  });

  assert.equal(result.apiKey, CONNECTION_API_KEY);
  assert.equal(result.evidence.source, "CONNECTION_ENCRYPTED_JSON");
});

test("never falls back to the global key when encrypted credentials are invalid", async () => {
  const invalidValues = [
    "not-encrypted",
    JSON.stringify({
      alg: "aes-256-gcm",
      iv: Buffer.alloc(12).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
      data: Buffer.from("tampered").toString("base64"),
    }),
    JSON.stringify({
      alg: "aes-256-cbc",
      iv: Buffer.alloc(12).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
      data: Buffer.from("tampered").toString("base64"),
    }),
  ];

  for (const credentialsEncrypted of invalidValues) {
    const mock = createMockDb(connection({ credentialsEncrypted }));

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(mock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          credentialsSecret: SECRET,
          globalApiKey: GLOBAL_API_KEY,
        }),
      /CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID/
    );
  }
});

test("requires the encryption secret for connection credentials", async () => {
  const encrypted = encryptCredentials({
    secret: SECRET,
    credentials: { apiKey: CONNECTION_API_KEY },
    format: "JSON",
  });
  const mock = createMockDb(
    connection({ credentialsEncrypted: encrypted })
  );

  await assert.rejects(
    () =>
      resolveChannexAriCredentials(mock.db as any, {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: " ",
        globalApiKey: GLOBAL_API_KEY,
      }),
    /CHANNEX_ARI_CREDENTIALS_SECRET_REQUIRED/
  );
});

test("rejects a wrong decryption secret and malformed decrypted credentials", async () => {
  const wrongSecretMock = createMockDb(
    connection({
      credentialsEncrypted: encryptCredentials({
        secret: SECRET,
        credentials: { apiKey: CONNECTION_API_KEY },
        format: "JSON",
      }),
    })
  );

  await assert.rejects(
    () =>
      resolveChannexAriCredentials(wrongSecretMock.db as any, {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: "wrong-secret",
      }),
    /CHANNEX_ARI_ENCRYPTED_CREDENTIALS_INVALID/
  );

  for (const credentials of [
    {},
    { apiKey: " " },
  ]) {
    const mock = createMockDb(
      connection({
        credentialsEncrypted: encryptCredentials({
          secret: SECRET,
          credentials,
          format: "JSON",
        }),
      })
    );

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(mock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          credentialsSecret: SECRET,
        }),
      /CHANNEX_ARI_CREDENTIAL_API_KEY_MISSING/
    );
  }

  const oversizedMock = createMockDb(
    connection({
      credentialsEncrypted: encryptCredentials({
        secret: SECRET,
        credentials: { apiKey: "x".repeat(4_097) },
        format: "JSON",
      }),
    })
  );

  await assert.rejects(
    () =>
      resolveChannexAriCredentials(oversizedMock.db as any, {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: SECRET,
      }),
    /CHANNEX_ARI_CREDENTIAL_API_KEY_INVALID/
  );
});

test("enforces the exact global connection metadata contract", async () => {
  const invalidMetadata = [
    null,
    [],
    "WHITE_LABEL_GLOBAL",
    {},
    {
      connectionType: CHANNEX_ARI_GLOBAL_CONNECTION_TYPE,
      managedBy: "Other",
    },
    {
      connectionType: "ORGANIZATION_MANAGED",
      managedBy: CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER,
    },
    {
      connectionType: "white_label_global",
      managedBy: CHANNEX_ARI_GLOBAL_CONNECTION_MANAGER,
    },
  ];

  for (const metadata of invalidMetadata) {
    const mock = createMockDb(connection({ metadata }));
    const expected =
      metadata !== null &&
      (typeof metadata !== "object" || Array.isArray(metadata))
        ? /CHANNEX_ARI_CONNECTION_METADATA_INVALID/
        : /CHANNEX_ARI_GLOBAL_CONNECTION_CONTRACT_INVALID/;

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(mock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          globalApiKey: GLOBAL_API_KEY,
        }),
      expected
    );
  }
});

test("requires a global key after the managed connection contract passes", async () => {
  const mock = createMockDb(connection());

  await assert.rejects(
    () =>
      resolveChannexAriCredentials(mock.db as any, {
        connectionId: "connection-1",
        organizationId: "org-1",
        globalApiKey: " ",
      }),
    /CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED/
  );

  const oversized = createMockDb(connection());
  await assert.rejects(
    () =>
      resolveChannexAriCredentials(oversized.db as any, {
        connectionId: "connection-1",
        organizationId: "org-1",
        globalApiKey: "x".repeat(4_097),
      }),
    /CHANNEX_ARI_CREDENTIAL_API_KEY_INVALID/
  );
});

test("rejects missing, cross-tenant, non-Channex and inactive connections", async () => {
  const scenarios = [
    {
      row: null,
      error: /CHANNEX_ARI_CREDENTIAL_CONNECTION_NOT_FOUND/,
    },
    {
      row: connection({ organizationId: "org-2" }),
      error: /CHANNEX_ARI_CREDENTIAL_ORGANIZATION_MISMATCH/,
    },
    {
      row: connection({ provider: "LODGIFY" }),
      error: /CHANNEX_ARI_CREDENTIAL_PROVIDER_MISMATCH/,
    },
    {
      row: connection({ status: "DISABLED" }),
      error: /CHANNEX_ARI_CREDENTIAL_CONNECTION_NOT_ACTIVE/,
    },
    {
      row: connection({ status: "ERROR" }),
      error: /CHANNEX_ARI_CREDENTIAL_CONNECTION_NOT_ACTIVE/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createMockDb(scenario.row);

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(mock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          globalApiKey: GLOBAL_API_KEY,
        }),
      scenario.error
    );
  }
});

test("validates identifiers before querying Prisma", async () => {
  for (const input of [
    {
      connectionId: " ",
      organizationId: "org-1",
      error: /CHANNEX_ARI_CREDENTIAL_CONNECTION_ID_REQUIRED/,
    },
    {
      connectionId: "connection-1",
      organizationId: " ",
      error: /CHANNEX_ARI_CREDENTIAL_ORGANIZATION_ID_REQUIRED/,
    },
  ]) {
    const mock = createMockDb(connection());

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(mock.db as any, {
          connectionId: input.connectionId,
          organizationId: input.organizationId,
          globalApiKey: GLOBAL_API_KEY,
        }),
      input.error
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("uses environment credentials only when explicit values are omitted", async () => {
  const previousSecret = process.env.PMS_CREDENTIALS_SECRET;
  const previousGlobalKey = process.env.CHANNEX_API_KEY;

  try {
    process.env.PMS_CREDENTIALS_SECRET = SECRET;
    process.env.CHANNEX_API_KEY = GLOBAL_API_KEY;

    const encryptedMock = createMockDb(
      connection({
        credentialsEncrypted: encryptCredentials({
          secret: SECRET,
          credentials: { apiKey: CONNECTION_API_KEY },
          format: "JSON",
        }),
      })
    );
    const encryptedResult = await resolveChannexAriCredentials(
      encryptedMock.db as any,
      {
        connectionId: "connection-1",
        organizationId: "org-1",
      }
    );
    assert.equal(encryptedResult.apiKey, CONNECTION_API_KEY);

    const globalMock = createMockDb(connection());
    const globalResult = await resolveChannexAriCredentials(
      globalMock.db as any,
      {
        connectionId: "connection-1",
        organizationId: "org-1",
      }
    );
    assert.equal(globalResult.apiKey, GLOBAL_API_KEY);

    await assert.rejects(
      () =>
        resolveChannexAriCredentials(encryptedMock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          credentialsSecret: " ",
        }),
      /CHANNEX_ARI_CREDENTIALS_SECRET_REQUIRED/
    );
    await assert.rejects(
      () =>
        resolveChannexAriCredentials(globalMock.db as any, {
          connectionId: "connection-1",
          organizationId: "org-1",
          globalApiKey: " ",
        }),
      /CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED/
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PMS_CREDENTIALS_SECRET;
    } else {
      process.env.PMS_CREDENTIALS_SECRET = previousSecret;
    }

    if (previousGlobalKey === undefined) {
      delete process.env.CHANNEX_API_KEY;
    } else {
      process.env.CHANNEX_API_KEY = previousGlobalKey;
    }
  }
});
