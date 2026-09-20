import assert from "node:assert/strict";
import test from "node:test";

import { searchGooglePlaces } from "./google-places-read-client.js";

test("Google Places read client sends a bounded field-masked search and filters distant results", async () => {
  let requestedUrl = "";
  let requestedHeaders: Readonly<Record<string, string>> = {};
  let requestedBody = "";

  const result = await searchGooglePlaces(
    {
      query: "Puerto Rican food",
      latitude: 18.2,
      longitude: -66.3,
      radiusMeters: 5_000,
      maxResults: 3,
      languageCode: "en",
    },
    {
      apiKey: "private-test-key",
      fetchImpl: async (input, init) => {
        requestedUrl = input;
        requestedHeaders = init.headers;
        requestedBody = init.body;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              places: [
                {
                  id: "place-near",
                  displayName: { text: "Nearby Restaurant" },
                  primaryTypeDisplayName: { text: "Puerto Rican restaurant" },
                  formattedAddress: "Nearby address",
                  location: { latitude: 18.201, longitude: -66.301 },
                  businessStatus: "OPERATIONAL",
                  googleMapsUri: "https://maps.google.com/?cid=near",
                },
                {
                  id: "place-far",
                  displayName: { text: "Distant Restaurant" },
                  location: { latitude: 18.5, longitude: -66.8 },
                },
              ],
            };
          },
        };
      },
    },
  );

  assert.equal(
    requestedUrl,
    "https://places.googleapis.com/v1/places:searchText",
  );
  assert.equal(requestedHeaders["X-Goog-Api-Key"], "private-test-key");
  assert.match(requestedHeaders["X-Goog-FieldMask"], /places\.displayName/);
  assert.doesNotMatch(requestedHeaders["X-Goog-FieldMask"], /currentOpeningHours|priceLevel|reviews/);
  assert.deepEqual(JSON.parse(requestedBody), {
    textQuery: "Puerto Rican food",
    pageSize: 3,
    languageCode: "en",
    locationBias: {
      circle: {
        center: { latitude: 18.2, longitude: -66.3 },
        radius: 5_000,
      },
    },
  });
  assert.equal(result.provider, "GOOGLE_PLACES");
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0]?.name, "Nearby Restaurant");
  assert.equal(result.places[0]?.currentOpeningStatus, "NOT_REQUESTED");
  assert.ok((result.places[0]?.straightLineDistanceMeters ?? 0) > 0);
  assert.doesNotMatch(JSON.stringify(result), /place-near|private-test-key/);
});

test("Google Places read client fails closed without a configured API key", async () => {
  await assert.rejects(
    searchGooglePlaces(
      {
        query: "pharmacy",
        latitude: 18.2,
        longitude: -66.3,
        radiusMeters: 5_000,
        maxResults: 3,
        languageCode: "es",
      },
      { apiKey: "" },
    ),
    /PIN_AI_RUNTIME_GOOGLE_PLACES_API_KEY_MISSING/,
  );
});
