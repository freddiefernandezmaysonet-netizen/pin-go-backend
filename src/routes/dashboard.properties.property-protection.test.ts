import assert from "node:assert/strict";
import test from "node:test";
import { hasPropertyAriConfigurationChanged } from "./dashboard.properties.route";

test("Property Protection fields do not trigger ARI configuration changes", () => {
  const existing = {
    dynamicPricingEnabled: true,
    seasonalPricingEnabled: true,
    holidayPricingEnabled: true,
    leadTimePricingEnabled: true,
    occupancyPricingEnabled: true,
    baseNightlyRate: 125,
    minimumNightlyRate: 90,
    maximumNightlyRate: 250,
    weekendMarkupPercent: 10,
    leadTimeLastMinuteDays: 3,
    leadTimeLastMinutePercent: -10,
    occupancyLookaheadDays: 30,
    occupancyLowThresholdPercent: 35,
    occupancyLowAdjustmentPercent: -10,
    occupancyHighThresholdPercent: 80,
    occupancyHighAdjustmentPercent: 15,
    minimumNights: 2,
    maximumNights: 14,
  };

  assert.equal(
    hasPropertyAriConfigurationChanged(existing, {
      propertyProtectionEnabled: true,
      propertyProtectionMode: "CARD_ON_FILE",
      maxDamageLiabilityAmount: 500,
    }),
    false
  );
});

test("ARI pricing fields still trigger ARI configuration changes", () => {
  assert.equal(
    hasPropertyAriConfigurationChanged(
      { baseNightlyRate: 125 },
      { baseNightlyRate: 130 }
    ),
    true
  );
});
