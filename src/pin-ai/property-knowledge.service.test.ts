import assert from "node:assert/strict";
import test from "node:test";

import {
  composePropertyKnowledgeSnapshot,
  getPropertyKnowledgeSnapshot,
} from "./property-knowledge.service.js";

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
      guestKnowledge: {
        version: 1,
        wifi: { ssid: "Benchmark WiFi", password: "guest-wifi-password" },
        parking: { instructions: "Use the marked space by the entrance." },
        arrivalInstructionsEn: "Park first, then walk to the main entrance.",
        arrivalInstructionsEs: "Estacione primero y camine a la entrada principal.",
        accessInstructionsEn: "Wake the keypad and press the confirm button after the assigned credential.",
        accessInstructionsEs: "Active el teclado y presione confirmar luego de la credencial asignada.",
        applianceGuides: { airConditioning: "Use the wall thermostat." },
        troubleshooting: { keypad: "If the display sleeps, touch the screen once." },
        utilities: { breakerPanel: "Hallway utility closet." },
        garbageInstructionsEn: "Use the bin beside the driveway.",
        garbageInstructionsEs: "Use el zafacón junto a la entrada.",
        checkoutInstructionsEn: "Close the door when leaving.",
        checkoutInstructionsEs: "Cierre la puerta al salir.",
        safetyInformation: { extinguisher: "Kitchen cabinet near the exit." },
        localNotes: ["Benchmark local note"],
        customFaq: { "Where is parking?": "Beside the entrance." },
      },
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
  assert.deepEqual(
    snapshot.facts.find((fact) => fact.key === "wifi")?.value,
    { ssid: "Benchmark WiFi", password: "guest-wifi-password" },
  );
  assert.equal(
    snapshot.facts.find((fact) => fact.key === "accessInstructions")?.value,
    "Wake the keypad and press the confirm button after the assigned credential.",
  );

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
      guestKnowledge: {
        version: 2,
        wifi: null,
        parking: null,
        arrivalInstructionsEn: "English arrival",
        arrivalInstructionsEs: "Llegada en español",
        accessInstructionsEn: "English access",
        accessInstructionsEs: "Acceso en español",
        applianceGuides: null,
        troubleshooting: null,
        utilities: null,
        garbageInstructionsEn: "English garbage",
        garbageInstructionsEs: "Basura en español",
        checkoutInstructionsEn: "English checkout",
        checkoutInstructionsEs: "Salida en español",
        safetyInformation: null,
        localNotes: null,
        customFaq: null,
      },
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
  const arrival = snapshot.facts.find((fact) => fact.key === "arrivalInstructions");
  const access = snapshot.facts.find((fact) => fact.key === "accessInstructions");
  const checkout = snapshot.facts.find((fact) => fact.key === "checkoutInstructions");

  assert.equal(description?.value, "Español");
  assert.equal(title?.value, "Reglas");
  assert.deepEqual(rules?.value, ["No fumar"]);
  assert.equal(arrival?.value, "Llegada en español");
  assert.equal(access?.value, "Acceso en español");
  assert.equal(checkout?.value, "Salida en español");
});

test("Property Knowledge query is hard scoped by organization and property", async () => {
  let capturedWhere: unknown;

  const prisma = {
    property: {
      async findFirst(args: any) {
        capturedWhere = args.where;
        return null;
      },
    },
  } as any;

  await assert.rejects(
    getPropertyKnowledgeSnapshot({
      prisma,
      organizationId: "benchmark-org-a",
      propertyId: "benchmark-property-a",
      language: "en",
    }),
    /PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND/,
  );

  assert.deepEqual(capturedWhere, {
    id: "benchmark-property-a",
    organizationId: "benchmark-org-a",
    status: "ACTIVE",
  });
});
