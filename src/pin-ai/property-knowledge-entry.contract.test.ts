import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePropertyKnowledgeEntryDraft,
} from "./property-knowledge-entry.contract.js";

test("normalizes a bilingual confirmed-guest knowledge entry", () => {
  const entry = normalizePropertyKnowledgeEntryDraft({
    category: "parking",
    key: "parking.instructions",
    titleEn: "Parking",
    titleEs: "Estacionamiento",
    contentEn: "Use the marked space beside the property.",
    contentEs: "Use el espacio marcado al lado de la propiedad.",
    visibility: "confirmed_guest",
    sortOrder: 20,
  });

  assert.deepEqual(entry, {
    category: "PARKING",
    key: "parking.instructions",
    titleEn: "Parking",
    titleEs: "Estacionamiento",
    contentEn: "Use the marked space beside the property.",
    contentEs: "Use el espacio marcado al lado de la propiedad.",
    visibility: "CONFIRMED_GUEST",
    sortOrder: 20,
  });
});

test("requires guest-facing content in at least one supported language", () => {
  assert.throws(
    () =>
      normalizePropertyKnowledgeEntryDraft({
        category: "PROPERTY",
        key: "property.note",
        titleEn: "Note",
      }),
    /PROPERTY_KNOWLEDGE_CONTENT_REQUIRED/,
  );
});

test("forbids public Wi-Fi knowledge", () => {
  assert.throws(
    () =>
      normalizePropertyKnowledgeEntryDraft({
        category: "WIFI",
        key: "wifi.main",
        contentEn: "Network details are provided to confirmed guests.",
        visibility: "PUBLIC",
      }),
    /PROPERTY_KNOWLEDGE_WIFI_PUBLIC_FORBIDDEN/,
  );
});

test("forbids access credentials in keys and content", () => {
  for (const key of [
    "access.door_code",
    "access.door.code",
    "access.activepasscode",
    "access.nfccredential",
  ]) {
    assert.throws(
      () =>
        normalizePropertyKnowledgeEntryDraft({
          category: "ACCESS",
          key,
          contentEn: "Use the credential issued for your stay.",
          visibility: "DURING_STAY",
        }),
      /PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN/,
    );
  }

  assert.throws(
    () =>
      normalizePropertyKnowledgeEntryDraft({
        category: "ACCESS",
        key: "access.arrival",
        contentEn: "The door code is 123456.",
        visibility: "DURING_STAY",
      }),
    /PROPERTY_KNOWLEDGE_ACCESS_CREDENTIAL_FORBIDDEN/,
  );
});

test("permits instructions that reference the separate access engine", () => {
  const entry = normalizePropertyKnowledgeEntryDraft({
    category: "ACCESS",
    key: "access.instructions",
    contentEn: "Your access code is available in the secure guest portal.",
    visibility: "DURING_STAY",
  });

  assert.equal(entry.key, "access.instructions");
});

test("accepts Wi-Fi details only behind a guest visibility boundary", () => {
  const entry = normalizePropertyKnowledgeEntryDraft({
    category: "WIFI",
    key: "wifi.main",
    contentEn: "Network: CasaGuest; password: palms-and-sun",
    visibility: "DURING_STAY",
  });

  assert.equal(entry.category, "WIFI");
  assert.equal(entry.visibility, "DURING_STAY");
});

test("rejects arbitrary keys and invalid sort positions", () => {
  assert.throws(
    () =>
      normalizePropertyKnowledgeEntryDraft({
        category: "ARRIVAL",
        key: "../../credential",
        contentEn: "Meet at the main entrance.",
      }),
    /PROPERTY_KNOWLEDGE_KEY_INVALID/,
  );

  assert.throws(
    () =>
      normalizePropertyKnowledgeEntryDraft({
        category: "ARRIVAL",
        key: "arrival.instructions",
        contentEn: "Meet at the main entrance.",
        sortOrder: -1,
      }),
    /PROPERTY_KNOWLEDGE_SORT_ORDER_INVALID/,
  );
});
