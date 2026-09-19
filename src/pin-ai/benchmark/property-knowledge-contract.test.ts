import assert from "node:assert/strict";
import test from "node:test";

import {
  PROPERTY_KNOWLEDGE_PROHIBITED_KEYS,
  assertPropertyKnowledgeSafe,
  type PropertyGuestKnowledgeDraft,
  type PropertyKnowledgeSnapshot,
} from "./property-knowledge-contract.js";

test("Property Knowledge V1 accepts guest-facing stable knowledge", () => {
  const draft: PropertyGuestKnowledgeDraft = {
    wifi: {
      ssid: "Benchmark WiFi",
      password: "benchmark-only-password",
      notes: "Network is available throughout the property.",
    },
    parking: {
      instructions: "Use the marked space beside the entrance.",
    },
    accessInstructions: "Wake the keypad before entering the assigned credential.",
    applianceGuides: {
      television: "Use the living-room remote and select HDMI 1.",
      airConditioning: "Use the wall thermostat.",
    },
    checkoutInstructions: "Leave by 11:00 AM and close the door behind you.",
  };

  assert.doesNotThrow(() => assertPropertyKnowledgeSafe(draft));
});

test("Property Knowledge V1 rejects operational credentials and payment secrets", () => {
  for (const prohibitedKey of PROPERTY_KNOWLEDGE_PROHIBITED_KEYS) {
    assert.throws(
      () =>
        assertPropertyKnowledgeSafe({
          access: {
            [prohibitedKey]: "secret-value",
          },
        }),
      new RegExp(`PROPERTY_KNOWLEDGE_PROHIBITED_FIELD:access\\.${prohibitedKey}`),
    );
  }
});

test("Property Knowledge snapshot remains tenant and property scoped", () => {
  const snapshot: PropertyKnowledgeSnapshot = {
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    language: "en",
    facts: [
      {
        category: "ACCESS",
        key: "lockLocation",
        value: "Front entrance",
        source: "LOCK",
        authoritative: true,
        guestVisible: true,
      },
      {
        category: "HOUSE_RULES",
        key: "rules",
        value: ["Adults only"],
        source: "GUEST_AGREEMENT",
        authoritative: true,
        guestVisible: true,
      },
    ],
  };

  assert.equal(snapshot.organizationId, "benchmark-org-a");
  assert.equal(snapshot.propertyId, "benchmark-property-a");
  assert.ok(snapshot.facts.every((fact) => fact.guestVisible));
});
