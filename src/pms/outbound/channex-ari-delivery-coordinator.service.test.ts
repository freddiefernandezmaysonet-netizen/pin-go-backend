import assert from "node:assert/strict";
import test from "node:test";

import { coordinateClaimedChannexAriDelivery } from "./channex-ari-delivery-coordinator.service";

const API_KEY = "secret-channex-api-key";
const CREDENTIALS_SECRET = "secret-pms-credentials-key";
const GLOBAL_API_KEY = "secret-global-channex-key";
const CLOCK = () => new Date("2026-07-28T12:00:00.000Z");

function claimedDelivery() {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    listingId: "listing-1",
    messageKind: "AVAILABILITY" as const,
    status: "PROCESSING" as const,
    payload: {
      values: [
        {
          property_id: "channex-property-1",
          room_type_id: "room-type-1",
          date: "2026-08-01",
          availability: 1,
        },
      ],
    },
    payloadHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payloadValueCount: 1,
    payloadBytes: 156,
    attemptCount: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-07-28T12:02:00.000Z"),
  };
}

test("resolves credentials before executing the claimed delivery", async () => {
  const db = { marker: "db" } as any;
  const delivery = claimedDelivery();
  const transport = { marker: "transport" } as any;
  const calls: string[] = [];
  const resolveInputs: any[] = [];
  const executeInputs: any[] = [];
  const credentialEvidence = {
    connectionId: "connection-1",
    organizationId: "org-1",
    source: "GLOBAL_MANAGED",
    connectionType: "WHITE_LABEL_GLOBAL",
    managedBy: "PinGo",
  };
  const execution = {
    delivery: { id: "delivery-1" },
    request: {
      endpoint: "/api/v1/availability",
      durationMs: 2_500,
    },
    completion: {
      retryClass: "SUCCESS",
      deliveryUpdate: { status: "SENT" },
    },
  };

  const result = await coordinateClaimedChannexAriDelivery({
    db,
    delivery,
    credentialsSecret: CREDENTIALS_SECRET,
    globalApiKey: GLOBAL_API_KEY,
    baseUrl: "https://staging.example.test",
    timeoutMs: 15_000,
    jitterMs: 321,
    completionReserveMs: 5_000,
    transport,
    clock: CLOCK,
    resolveCredentials: (async (receivedDb: any, input: any) => {
      calls.push("resolve");
      resolveInputs.push({ receivedDb, input });
      return {
        apiKey: API_KEY,
        evidence: credentialEvidence,
      } as any;
    }) as any,
    execute: (async (input: any) => {
      calls.push("execute");
      executeInputs.push(input);
      return execution as any;
    }) as any,
  });

  assert.deepEqual(calls, ["resolve", "execute"]);
  assert.deepEqual(resolveInputs, [
    {
      receivedDb: db,
      input: {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: CREDENTIALS_SECRET,
        globalApiKey: GLOBAL_API_KEY,
      },
    },
  ]);
  assert.deepEqual(executeInputs, [
    {
      db,
      delivery,
      apiKey: API_KEY,
      baseUrl: "https://staging.example.test",
      timeoutMs: 15_000,
      jitterMs: 321,
      completionReserveMs: 5_000,
      transport,
      clock: CLOCK,
    },
  ]);
  assert.deepEqual(result, {
    credentials: credentialEvidence,
    execution,
  });
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes(CREDENTIALS_SECRET), false);
  assert.equal(JSON.stringify(result).includes(GLOBAL_API_KEY), false);
});

test("forwards omitted optional settings without inventing runtime values", async () => {
  const db = {} as any;
  const delivery = claimedDelivery();
  const executeInputs: any[] = [];

  await coordinateClaimedChannexAriDelivery({
    db,
    delivery,
    resolveCredentials: (async (_db: any, input: any) => {
      assert.deepEqual(input, {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: undefined,
        globalApiKey: undefined,
      });

      return {
        apiKey: API_KEY,
        evidence: {
          connectionId: "connection-1",
          organizationId: "org-1",
          source: "CONNECTION_ENCRYPTED_JSON",
          connectionType: null,
          managedBy: null,
        },
      } as any;
    }) as any,
    execute: (async (input: any) => {
      executeInputs.push(input);
      return { ok: true } as any;
    }) as any,
  });

  assert.deepEqual(executeInputs, [
    {
      db,
      delivery,
      apiKey: API_KEY,
      baseUrl: undefined,
      timeoutMs: undefined,
      jitterMs: undefined,
      completionReserveMs: undefined,
      transport: undefined,
      clock: undefined,
    },
  ]);
});

test("does not execute when credential resolution fails", async () => {
  let executeCalls = 0;

  await assert.rejects(
    () =>
      coordinateClaimedChannexAriDelivery({
        db: {} as any,
        delivery: claimedDelivery(),
        resolveCredentials: (async () => {
          throw new Error("CREDENTIAL_RESOLUTION_FAILED");
        }) as any,
        execute: (async () => {
          executeCalls += 1;
          return {} as any;
        }) as any,
      }),
    /CREDENTIAL_RESOLUTION_FAILED/
  );

  assert.equal(executeCalls, 0);
});

test("propagates executor failure without retrying or resolving twice", async () => {
  let resolveCalls = 0;
  let executeCalls = 0;

  await assert.rejects(
    () =>
      coordinateClaimedChannexAriDelivery({
        db: {} as any,
        delivery: claimedDelivery(),
        resolveCredentials: (async () => {
          resolveCalls += 1;
          return {
            apiKey: API_KEY,
            evidence: {
              connectionId: "connection-1",
              organizationId: "org-1",
              source: "GLOBAL_MANAGED",
              connectionType: "WHITE_LABEL_GLOBAL",
              managedBy: "PinGo",
            },
          } as any;
        }) as any,
        execute: (async () => {
          executeCalls += 1;
          throw new Error("DELIVERY_EXECUTION_FAILED");
        }) as any,
      }),
    /DELIVERY_EXECUTION_FAILED/
  );

  assert.equal(resolveCalls, 1);
  assert.equal(executeCalls, 1);
});

test("does not mutate the claimed delivery", async () => {
  const delivery = claimedDelivery();
  const before = structuredClone(delivery);

  await coordinateClaimedChannexAriDelivery({
    db: {} as any,
    delivery,
    resolveCredentials: (async () => ({
      apiKey: API_KEY,
      evidence: {
        connectionId: "connection-1",
        organizationId: "org-1",
        source: "GLOBAL_MANAGED",
        connectionType: "WHITE_LABEL_GLOBAL",
        managedBy: "PinGo",
      },
    })) as any,
    execute: (async () => ({ ok: true })) as any,
  });

  assert.deepEqual(delivery, before);
});
