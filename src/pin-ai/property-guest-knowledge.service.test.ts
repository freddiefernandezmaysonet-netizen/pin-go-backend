import assert from "node:assert/strict";
import test from "node:test";

import {
  getEditablePropertyGuestKnowledge,
  normalizePropertyGuestKnowledgeInput,
  upsertPropertyGuestKnowledge,
} from "./property-guest-knowledge.service.js";

test("normalizer allows guest Wi-Fi but rejects operational access credentials", () => {
  const normalized = normalizePropertyGuestKnowledgeInput({
    wifi: {
      ssid: "Casa WiFi",
      password: "guest-visible-password",
    },
    accessInstructionsEn:
      "Wake the keypad and use the credential assigned to the reservation.",
  });

  assert.deepEqual(normalized.wifi, {
    ssid: "Casa WiFi",
    password: "guest-visible-password",
  });

  assert.throws(
    () =>
      normalizePropertyGuestKnowledgeInput({
        troubleshooting: {
          activePasscode: "123456",
        },
      }),
    /PROPERTY_GUEST_KNOWLEDGE_PROHIBITED_FIELD:troubleshooting\.activePasscode/,
  );
});

test("authoring is hard scoped by organization and property", async () => {
  let propertyWhere: unknown;
  let upsertCalled = false;

  const prisma = {
    property: {
      async findFirst(args: any) {
        propertyWhere = args.where;
        return null;
      },
    },
    propertyGuestKnowledge: {
      async findUnique() {
        return null;
      },
      async upsert() {
        upsertCalled = true;
        return {};
      },
    },
  } as any;

  await assert.rejects(
    upsertPropertyGuestKnowledge({
      prisma,
      organizationId: "benchmark-org-a",
      propertyId: "benchmark-property-a",
      input: {
        arrivalInstructionsEn: "Use the main entrance.",
      },
    }),
    /PROPERTY_GUEST_KNOWLEDGE_PROPERTY_NOT_FOUND/,
  );

  assert.equal(upsertCalled, false);
  assert.deepEqual(propertyWhere, {
    id: "benchmark-property-a",
    organizationId: "benchmark-org-a",
    status: "ACTIVE",
  });
});

test("authoring creates version 1 and increments version on update", async () => {
  let capturedUpsert: any;

  const prisma = {
    property: {
      async findFirst() {
        return { id: "benchmark-property-a" };
      },
    },
    propertyGuestKnowledge: {
      async findUnique() {
        return null;
      },
      async upsert(args: any) {
        capturedUpsert = args;
        return {
          propertyId: "benchmark-property-a",
          version: 2,
        };
      },
    },
  } as any;

  const result = await upsertPropertyGuestKnowledge({
    prisma,
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    input: {
      parking: {
        instructions: "Park beside the entrance.",
      },
      checkoutInstructionsEs: "Cierre la puerta al salir.",
    },
  });

  assert.equal(capturedUpsert.where.propertyId, "benchmark-property-a");
  assert.equal(capturedUpsert.create.version, 1);
  assert.deepEqual(capturedUpsert.update.version, { increment: 1 });
  assert.equal(result.version, 2);
});

test("editable read verifies tenant ownership before returning knowledge", async () => {
  let readCalled = false;

  const prisma = {
    property: {
      async findFirst() {
        return { id: "benchmark-property-a" };
      },
    },
    propertyGuestKnowledge: {
      async findUnique(args: any) {
        readCalled = true;
        assert.deepEqual(args.where, {
          propertyId: "benchmark-property-a",
        });
        return {
          propertyId: "benchmark-property-a",
          version: 3,
        };
      },
      async upsert() {
        return {};
      },
    },
  } as any;

  const result: any = await getEditablePropertyGuestKnowledge({
    prisma,
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
  });

  assert.equal(readCalled, true);
  assert.equal(result.version, 3);
});
