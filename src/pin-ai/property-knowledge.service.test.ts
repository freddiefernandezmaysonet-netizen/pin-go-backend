import assert from "node:assert/strict";
import test from "node:test";

import {
  composePropertyKnowledgeSnapshot,
  getPropertyKnowledgeSnapshot,
} from "./property-knowledge.service.js";

function propertyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "benchmark-property-a",
    organizationId: "benchmark-org-a",
    name: "Benchmark Property",
    publicTitle: "Benchmark Stay",
    publicDescription: "A guest-facing description.",
    publicDescriptionEs: "Una descripción para huéspedes.",
    maxGuests: 4,
    timezone: "America/Puerto_Rico",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    guestAccessMode: "PASSCODE_ONLY",
    amenities: [],
    locks: [],
    propertyDevices: [],
    guestAgreements: [],
    cancellationPolicies: [],
    knowledgeEntries: [],
    reservations: [],
    ...overrides,
  } as any;
}

test("Property Knowledge composes existing Pin&Go sources without operational credentials", () => {
  const snapshot = composePropertyKnowledgeSnapshot({
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "en",
    property: {
      id: "benchmark-property-a",
      organizationId: "benchmark-org-a",
      name: "Benchmark Property",
      publicTitle: "Benchmark Stay",
      publicDescription: "A guest-facing description.",
      publicDescriptionEs: "Una descripción para huéspedes.",
      maxGuests: 4,
      timezone: "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      guestAccessMode: "PASSCODE_ONLY",
      amenities: [
        {
          name: "Wi-Fi",
          description: "Included",
          chargeMode: "INCLUDED",
        },
      ],
      locks: [
        {
          displayName: "Front Door",
          locationLabel: "Main entrance",
          ttlockLockName: "Casa Front",
        },
      ],
      propertyDevices: [
        {
          name: "Living Room AC",
          type: "AIR_CONDITIONER",
          provider: "TUYA",
        },
      ],
      guestAgreements: [
        {
          version: "v1",
          title: "Guest Rules",
          titleEn: "Guest Rules",
          titleEs: "Reglas del huésped",
          guestFacingSummary: "Adults only.",
          guestFacingSummaryEn: "Adults only.",
          guestFacingSummaryEs: "Solo adultos.",
          rules: ["No smoking"],
          rulesEn: ["No smoking"],
          rulesEs: ["No fumar"],
        },
      ],
      cancellationPolicies: [
        {
          name: "Flexible",
          guestFacingSummary: "100% refund within the eligible window.",
          description: null,
          refundRules: [{ minHoursBeforeCheckIn: 720, refundPercent: 100 }],
          nonRefundableScenarios: ["EARLY_DEPARTURE"],
        },
      ],
    } as any,
  });

  assert.equal(snapshot.organizationId, "benchmark-org-a");
  assert.equal(snapshot.propertyId, "benchmark-property-a");
  assert.ok(snapshot.facts.some((fact) => fact.key === "checkInTime"));
  assert.ok(snapshot.facts.some((fact) => fact.key === "locks"));
  assert.ok(snapshot.facts.some((fact) => fact.key === "rules"));

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /ttlockLockId/);
  assert.doesNotMatch(serialized, /externalId/);
  assert.doesNotMatch(serialized, /activePasscode/);
  assert.doesNotMatch(serialized, /futurePasscode/);
  assert.doesNotMatch(serialized, /nfcCredential/);
});

test("Property Knowledge uses Spanish guest agreement fields when requested", () => {
  const snapshot = composePropertyKnowledgeSnapshot({
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "es",
    property: {
      id: "benchmark-property-a",
      organizationId: "benchmark-org-a",
      name: "Benchmark Property",
      publicTitle: null,
      publicDescription: "English",
      publicDescriptionEs: "Español",
      maxGuests: 4,
      timezone: "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      guestAccessMode: "PASSCODE_ONLY",
      amenities: [],
      locks: [],
      propertyDevices: [],
      guestAgreements: [
        {
          version: "v1",
          title: "Fallback",
          titleEn: "Rules",
          titleEs: "Reglas",
          guestFacingSummary: null,
          guestFacingSummaryEn: "English summary",
          guestFacingSummaryEs: "Resumen español",
          rules: null,
          rulesEn: ["No smoking"],
          rulesEs: ["No fumar"],
        },
      ],
      cancellationPolicies: [],
    } as any,
  });

  const description = snapshot.facts.find((fact) => fact.key === "description");
  const title = snapshot.facts.find((fact) => fact.key === "agreementTitle");
  const rules = snapshot.facts.find((fact) => fact.key === "rules");

  assert.equal(description?.value, "Español");
  assert.equal(title?.value, "Reglas");
  assert.deepEqual(rules?.value, ["No fumar"]);
});

test("persisted Property Knowledge honors guest visibility and language", () => {
  const property = propertyRecord({
    knowledgeEntries: [
      {
        category: "PARKING",
        key: "parking.instructions",
        titleEn: "Parking",
        titleEs: "Estacionamiento",
        contentEn: "Use space 4.",
        contentEs: "Use el espacio 4.",
        visibility: "PUBLIC",
        sortOrder: 10,
        revision: 1,
        isActive: true,
      },
      {
        category: "ARRIVAL",
        key: "arrival.instructions",
        titleEn: "Arrival",
        titleEs: "Llegada",
        contentEn: "Meet at the lobby.",
        contentEs: "Reúnase en el vestíbulo.",
        visibility: "CONFIRMED_GUEST",
        sortOrder: 20,
        revision: 1,
        isActive: true,
      },
      {
        category: "WIFI",
        key: "wifi.main",
        titleEn: "Wi-Fi",
        titleEs: "Wi-Fi",
        contentEn: "Network: CasaGuest; password: palms-and-sun",
        contentEs: "Red: CasaGuest; contraseña: palms-and-sun",
        visibility: "DURING_STAY",
        sortOrder: 30,
        revision: 2,
        isActive: true,
      },
      {
        category: "PROPERTY",
        key: "property.inactive-note",
        titleEn: null,
        titleEs: null,
        contentEn: "Do not expose this inactive entry.",
        contentEs: null,
        visibility: "PUBLIC",
        sortOrder: 40,
        revision: 3,
        isActive: false,
      },
    ],
    reservations: [
      {
        id: "reservation-a",
        status: "ACTIVE",
        checkIn: new Date("2026-09-20T20:00:00.000Z"),
        checkOut: new Date("2026-09-22T15:00:00.000Z"),
      },
    ],
  });

  const beforeStay = composePropertyKnowledgeSnapshot({
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "en",
    currentDateTime: "2026-09-20T12:00:00.000Z",
    property,
  });
  const beforeKeys = beforeStay.facts.map((fact) => fact.key);
  assert.ok(beforeKeys.includes("parking.instructions"));
  assert.ok(beforeKeys.includes("arrival.instructions"));
  assert.ok(!beforeKeys.includes("wifi.main"));
  assert.ok(!beforeKeys.includes("property.inactive-note"));

  const duringStay = composePropertyKnowledgeSnapshot({
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "es",
    currentDateTime: "2026-09-21T14:00:00.000Z",
    property,
  });
  const wifi = duringStay.facts.find((fact) => fact.key === "wifi.main");
  assert.deepEqual(wifi, {
    category: "WIFI",
    key: "wifi.main",
    value: {
      title: "Wi-Fi",
      content: "Red: CasaGuest; contraseña: palms-and-sun",
    },
    source: "PROPERTY_GUEST_KNOWLEDGE",
    authoritative: true,
  });

  const withoutReservation = composePropertyKnowledgeSnapshot({
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "en",
    currentDateTime: "2026-09-21T14:00:00.000Z",
    property: propertyRecord({ knowledgeEntries: property.knowledgeEntries }),
  });
  const anonymousKeys = withoutReservation.facts.map((fact) => fact.key);
  assert.ok(anonymousKeys.includes("parking.instructions"));
  assert.ok(!anonymousKeys.includes("arrival.instructions"));
  assert.ok(!anonymousKeys.includes("wifi.main"));
});

test("persisted Property Knowledge fails closed on an access credential", () => {
  assert.throws(
    () =>
      composePropertyKnowledgeSnapshot({
        organizationId: "benchmark-org-a",
        propertyId: "benchmark-property-a",
        language: "en",
        currentDateTime: "2026-09-21T14:00:00.000Z",
        property: propertyRecord({
          knowledgeEntries: [
            {
              category: "ACCESS",
              key: "access.instructions",
              titleEn: "Entry",
              titleEs: null,
              contentEn: "The door code is 123456.",
              contentEs: null,
              visibility: "DURING_STAY",
              sortOrder: 0,
              revision: 1,
              isActive: true,
            },
          ],
          reservations: [
            {
              id: "reservation-a",
              status: "ACTIVE",
              checkIn: new Date("2026-09-20T20:00:00.000Z"),
              checkOut: new Date("2026-09-22T15:00:00.000Z"),
            },
          ],
        }),
      }),
    /PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN/,
  );
});

test("Property Knowledge query is hard scoped by organization and property", async () => {
  let capturedWhere: unknown;
  let capturedSelect: any;

  const prisma = {
    property: {
      async findFirst(args: any) {
        capturedWhere = args.where;
        capturedSelect = args.select;
        return null;
      },
    },
  } as any;

  await assert.rejects(
    getPropertyKnowledgeSnapshot({
      prisma,
      organizationId: "benchmark-org-a",
      propertyId: "benchmark-property-a",
      reservationId: "reservation-a",
      currentDateTime: "2026-09-21T14:00:00.000Z",
      language: "en",
    }),
    /PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND/,
  );

  assert.deepEqual(capturedWhere, {
    id: "benchmark-property-a",
    organizationId: "benchmark-org-a",
    status: "ACTIVE",
  });
  assert.deepEqual(capturedSelect.knowledgeEntries.where, { isActive: true });
  assert.deepEqual(capturedSelect.reservations.where, {
    id: "reservation-a",
    status: "ACTIVE",
  });
  assert.equal(capturedSelect.knowledgeEntries.select.createdByUserId, undefined);
  assert.equal(capturedSelect.knowledgeEntries.select.updatedByUserId, undefined);
});
