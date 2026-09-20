import assert from "node:assert/strict";
import test from "node:test";
import { resolveWebSearchLocation } from "./web-search-location.js";

test("derives Puerto Rico country only from the canonical Puerto Rico timezone", () => {
  assert.deepEqual(
    resolveWebSearchLocation({
      city: null,
      region: null,
      country: null,
      timezone: "America/Puerto_Rico",
    }),
    {
      city: "",
      region: "",
      country: "PR",
      timezone: "America/Puerto_Rico",
      label: "PR",
    },
  );
});

test("keeps an explicit valid country instead of deriving one", () => {
  const location = resolveWebSearchLocation({
    city: "Miami",
    region: "Florida",
    country: "us",
    timezone: "America/Puerto_Rico",
  });

  assert.equal(location.country, "US");
  assert.equal(location.label, "Miami, Florida, US");
});

test("does not infer a country from an unrelated timezone", () => {
  const location = resolveWebSearchLocation({
    city: null,
    region: null,
    country: null,
    timezone: "America/New_York",
  });

  assert.equal(location.country, "");
  assert.equal(location.label, "");
});
