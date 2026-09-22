import assert from "node:assert/strict";
import test from "node:test";

const DISCLOSURE_VERSION = "property_protection_card_on_file_v1";

function projectPropertyProtection(input: {
  enabled: boolean;
  mode: "CARD_ON_FILE";
  maxDamageLiabilityAmount: number | null;
}) {
  return input.enabled
    ? {
        enabled: true,
        mode: input.mode,
        maxDamageLiabilityAmount: input.maxDamageLiabilityAmount,
        currency: "usd",
        disclosureVersion: DISCLOSURE_VERSION,
      }
    : {
        enabled: false,
        mode: input.mode,
        maxDamageLiabilityAmount: null,
        currency: "usd",
        disclosureVersion: DISCLOSURE_VERSION,
      };
}

test("Property Protection OFF never publishes a liability amount", () => {
  assert.deepEqual(
    projectPropertyProtection({
      enabled: false,
      mode: "CARD_ON_FILE",
      maxDamageLiabilityAmount: 500,
    }),
    {
      enabled: false,
      mode: "CARD_ON_FILE",
      maxDamageLiabilityAmount: null,
      currency: "usd",
      disclosureVersion: DISCLOSURE_VERSION,
    }
  );
});

test("Property Protection ON publishes the configured CARD_ON_FILE contract", () => {
  assert.deepEqual(
    projectPropertyProtection({
      enabled: true,
      mode: "CARD_ON_FILE",
      maxDamageLiabilityAmount: 500,
    }),
    {
      enabled: true,
      mode: "CARD_ON_FILE",
      maxDamageLiabilityAmount: 500,
      currency: "usd",
      disclosureVersion: DISCLOSURE_VERSION,
    }
  );
});
