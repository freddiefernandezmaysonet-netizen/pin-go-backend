import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { channexAdapter } from "./channex.adapter";

const REVISION_FIXTURE = {
  data: {
    id: "revision-001",
    attributes: {
      booking_id: "booking-001",
      unique_id: "unique-001",
      ota_reservation_code: "OTA-001",
      property_id: "property-001",
      live_feed_event_id: "feed-001",
      system_id: "system-001",
      inserted_at: "2026-07-24T12:00:00.000Z",
      status: "new",
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      guest_name: "Test Guest",
      guest_email: "guest@example.com",
      guest_phone: "+17875550123",
      rooms: [
        {
          room_type_id: "room-type-001",
          room_type_name: "Suite 1",
        },
      ],
    },
  },
};

function requireAdapterMethod<T>(
  method: T | undefined,
  name: string
): NonNullable<T> {
  if (!method) {
    throw new Error(`Expected Channex adapter method ${name}`);
  }

  return method as NonNullable<T>;
}

test("property-only webhook remains a Feed recovery signal", () => {
  const parsed = channexAdapter.parseWebhook({
    headers: {},
    body: {
      event: "booking",
      property_id: "property-001",
      user_id: "user-001",
    },
  });

  assert.equal(parsed.eventType, "booking");
  assert.deepEqual(parsed.bookingRevision, {
    propertyId: "property-001",
    bookingUniqueId: null,
    otaReservationCode: null,
    liveFeedEventId: null,
    systemId: null,
    insertedAt: null,
  });
  assert.equal(parsed.externalReservationId, undefined);
  assert.equal(parsed.externalEventId, null);
});

test("webhook identifiers remain semantically separated", () => {
  const parsed = channexAdapter.parseWebhook({
    headers: {},
    body: {
      event: "booking_modification",
      property_id: "property-001",
      booking_revision_id: "revision-001",
      booking_id: "booking-001",
      reservation_id: "must-not-be-booking-id",
      unique_id: "unique-001",
      ota_reservation_code: "OTA-001",
      live_feed_event_id: "feed-001",
      system_id: "system-001",
      inserted_at: "2026-07-24T12:00:00.000Z",
    },
  });

  assert.equal(parsed.eventType, "booking_modification");
  assert.equal(parsed.externalReservationId, "booking-001");
  assert.equal(parsed.externalEventId, "feed-001");
  assert.deepEqual(parsed.bookingRevision, {
    revisionId: "revision-001",
    bookingId: "booking-001",
    bookingUniqueId: "unique-001",
    otaReservationCode: "OTA-001",
    propertyId: "property-001",
    liveFeedEventId: "feed-001",
    systemId: "system-001",
    insertedAt: "2026-07-24T12:00:00.000Z",
  });
});

test("fetchBookingRevision uses only the revision endpoint", async () => {
  process.env.CHANNEX_API_KEY = "test-api-key";

  const originalGet = axios.get;
  let requestedUrl = "";

  axios.get = (async (url: string) => {
    requestedUrl = url;
    return { data: REVISION_FIXTURE };
  }) as typeof axios.get;

  try {
    const fetchBookingRevision = requireAdapterMethod(
      channexAdapter.fetchBookingRevision,
      "fetchBookingRevision"
    );
    const result = await fetchBookingRevision({
      connection: {},
      revisionId: "revision-001",
    });

    assert.match(
      requestedUrl,
      /\/api\/v1\/booking_revisions\/revision-001$/
    );
    assert.equal(result.identity.revisionId, "revision-001");
    assert.equal(result.identity.bookingId, "booking-001");
    assert.equal(result.reservation.externalReservationId, "booking-001");
    assert.equal(result.reservation.externalListingId, "room-type-001");
  } finally {
    axios.get = originalGet;
  }
});

test("Channex adapter does not expose Booking Find or booking-by-id", () => {
  assert.equal(channexAdapter.fetchReservation, undefined);
});

test("Feed requests oldest revisions first", async () => {
  process.env.CHANNEX_API_KEY = "test-api-key";

  const originalGet = axios.get;
  let requestedUrl = "";
  let requestedConfig: Parameters<typeof axios.get>[1] | undefined;

  axios.get = (async (
    url: string,
    config?: Parameters<typeof axios.get>[1]
  ) => {
    requestedUrl = url;
    requestedConfig = config;
    return { data: { data: [REVISION_FIXTURE.data] } };
  }) as typeof axios.get;

  try {
    const fetchBookingRevisionFeed = requireAdapterMethod(
      channexAdapter.fetchBookingRevisionFeed,
      "fetchBookingRevisionFeed"
    );
    const result = await fetchBookingRevisionFeed({ connection: {} });

    assert.match(requestedUrl, /\/api\/v1\/booking_revisions\/feed$/);
    assert.deepEqual(requestedConfig?.params, {
      "order[inserted_at]": "asc",
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.identity.revisionId, "revision-001");
  } finally {
    axios.get = originalGet;
  }
});

test("acknowledgement uses the exact revision ACK endpoint", async () => {
  process.env.CHANNEX_API_KEY = "test-api-key";

  const originalPost = axios.post;
  let requestedUrl = "";
  let requestedBody: unknown;

  axios.post = (async (url: string, body: unknown) => {
    requestedUrl = url;
    requestedBody = body;
    return { data: {} };
  }) as typeof axios.post;

  try {
    const acknowledgeBookingRevision = requireAdapterMethod(
      channexAdapter.acknowledgeBookingRevision,
      "acknowledgeBookingRevision"
    );
    await acknowledgeBookingRevision({
      connection: {},
      revisionId: "revision-001",
    });

    assert.match(
      requestedUrl,
      /\/api\/v1\/booking_revisions\/revision-001\/ack$/
    );
    assert.deepEqual(requestedBody, {});
  } finally {
    axios.post = originalPost;
  }
});

test("production booking revision requests ignore legacy and connection credentials", async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    otaKey: process.env.OTA_CONNECTION_API_KEY,
    otaOrigin: process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN,
    legacyKey: process.env.CHANNEX_API_KEY,
    legacyOrigin: process.env.CHANNEX_API_BASE_URL,
  };
  process.env.NODE_ENV = "production";
  process.env.OTA_CONNECTION_API_KEY = "ota-production-key";
  process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN = "https://app.channex.io";
  process.env.CHANNEX_API_KEY = "legacy-key-must-be-ignored";
  process.env.CHANNEX_API_BASE_URL = "https://staging.channex.io";

  const originalGet = axios.get;
  let requestedUrl = "";
  let requestedConfig: Parameters<typeof axios.get>[1] | undefined;
  axios.get = (async (url: string, config?: Parameters<typeof axios.get>[1]) => {
    requestedUrl = url;
    requestedConfig = config;
    return { data: REVISION_FIXTURE };
  }) as typeof axios.get;

  try {
    const fetchBookingRevision = requireAdapterMethod(
      channexAdapter.fetchBookingRevision,
      "fetchBookingRevision"
    );
    await fetchBookingRevision({
      connection: {},
      revisionId: "revision-001",
    });

    assert.equal(
      requestedUrl,
      "https://app.channex.io/api/v1/booking_revisions/revision-001"
    );
    assert.equal(
      (requestedConfig?.headers as Record<string, string>)["user-api-key"],
      "ota-production-key"
    );
  } finally {
    axios.get = originalGet;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.otaKey === undefined) delete process.env.OTA_CONNECTION_API_KEY;
    else process.env.OTA_CONNECTION_API_KEY = previous.otaKey;
    if (previous.otaOrigin === undefined) {
      delete process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN;
    } else process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN = previous.otaOrigin;
    if (previous.legacyKey === undefined) delete process.env.CHANNEX_API_KEY;
    else process.env.CHANNEX_API_KEY = previous.legacyKey;
    if (previous.legacyOrigin === undefined) delete process.env.CHANNEX_API_BASE_URL;
    else process.env.CHANNEX_API_BASE_URL = previous.legacyOrigin;
  }
});

test("production adapter fails before HTTP when OTA origin is not app.channex.io", async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    otaKey: process.env.OTA_CONNECTION_API_KEY,
    otaOrigin: process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN,
  };
  process.env.NODE_ENV = "production";
  process.env.OTA_CONNECTION_API_KEY = "ota-production-key";
  process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN = "https://staging.channex.io";

  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = (async () => {
    requestCount += 1;
    return { data: REVISION_FIXTURE };
  }) as typeof axios.get;

  try {
    const fetchBookingRevision = requireAdapterMethod(
      channexAdapter.fetchBookingRevision,
      "fetchBookingRevision"
    );
    await assert.rejects(
      fetchBookingRevision({ connection: {}, revisionId: "revision-001" }),
      /CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED/
    );
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.otaKey === undefined) delete process.env.OTA_CONNECTION_API_KEY;
    else process.env.OTA_CONNECTION_API_KEY = previous.otaKey;
    if (previous.otaOrigin === undefined) {
      delete process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN;
    } else process.env.OTA_CONNECTION_PROVIDER_API_ORIGIN = previous.otaOrigin;
  }
});
