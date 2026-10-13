import assert from "node:assert/strict";
import test from "node:test";
import { resolveWebSearchLocation, resolveStoredPropertyLocation } from "./web-search-location.js";

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

test("stored exact location preserves decimal coordinates without geocoding", () => {
  assert.deepEqual(resolveStoredPropertyLocation({ latitude: { toString: () => "29.4241000" },
    longitude: "-98.4936000", city: "San Antonio", region: "Texas", country: "US", timezone: "America/Chicago" }), {
    source: "PERSISTED_PROPERTY", latitude: 29.4241, longitude: -98.4936,
    city: "San Antonio", region: "Texas", country: "US",
  });
});

test("missing or invalid stored coordinates remain unknown and valid zero is preserved", () => {
  const area = { city: "San Juan", region: "PR", country: "PR", timezone: "America/Puerto_Rico" };
  for (const [latitude, longitude] of [[null, -66], [18, undefined], ["", -66], ["   ", -66],
    [true, -66], [91, -66], [18, -181], [Infinity, -66], [18, NaN]]) {
    assert.equal(resolveStoredPropertyLocation({ ...area, latitude, longitude }), null);
  }
  assert.equal(resolveStoredPropertyLocation({ ...area, latitude: 0, longitude: 0 })?.latitude, 0);
});
