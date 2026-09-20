import assert from "node:assert/strict";
import test from "node:test";
import { applyDefaultMarketSeasonsForProperty } from "./market-season-template.service";
import { applyDefaultHolidayPricingForProperty } from "./holiday-pricing-template.service";

test("Puerto Rico Google Places geography resolves to the Puerto Rico market for default seasons", async () => {
  const createdSeasons: any[] = [];
  const propertyUpdates: any[] = [];

  const db = {
    property: {
      findUnique: async () => ({
        id: "property-pr",
        country: "Puerto Rico",
        region: "Puerto Rico",
      }),
      update: async (args: any) => {
        propertyUpdates.push(args);
        return {};
      },
    },
    marketSeasonTemplate: {
      findMany: async (args: any) => {
        if (
          args?.where?.country === "United States" &&
          args?.where?.region === "Puerto Rico"
        ) {
          return [
            {
              name: "Winter Peak",
              startMonth: 12,
              startDay: 1,
              endMonth: 4,
              endDay: 30,
              adjustmentPercent: 25,
              type: "PEAK",
              isActive: true,
            },
          ];
        }

        return [];
      },
    },
    propertySeason: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async (args: any) => {
        createdSeasons.push(args.data);
        return args.data;
      },
      update: async () => ({}),
    },
  } as any;

  const result = await applyDefaultMarketSeasonsForProperty("property-pr", db);

  assert.equal(result.skipped, false);
  assert.equal(result.created, 1);
  assert.equal(createdSeasons.length, 1);
  assert.equal(createdSeasons[0].source, "PIN_GO_DEFAULT");
  assert.deepEqual(propertyUpdates.at(-1)?.data, {
    seasonalPricingEnabled: true,
  });
});

test("Puerto Rico Google Places geography resolves to the Puerto Rico market for holiday pricing", async () => {
  const createdHolidays: any[] = [];
  const propertyUpdates: any[] = [];

  const db = {
    property: {
      findUnique: async () => ({
        id: "property-pr",
        country: "Puerto Rico",
        region: "Puerto Rico",
      }),
      update: async (args: any) => {
        propertyUpdates.push(args);
        return {};
      },
    },
    propertyHolidayPricing: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async (args: any) => {
        createdHolidays.push(args.data);
        return args.data;
      },
      update: async () => ({}),
    },
  } as any;

  const result = await applyDefaultHolidayPricingForProperty("property-pr", db);

  assert.equal(result.skipped, false);
  assert.equal(result.created, 4);
  assert.equal(createdHolidays.length, 4);
  assert.ok(createdHolidays.every((item) => item.source === "PIN_GO_DEFAULT"));
  assert.deepEqual(propertyUpdates.at(-1)?.data, {
    holidayPricingEnabled: true,
  });
});
