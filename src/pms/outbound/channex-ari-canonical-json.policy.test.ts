import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateChannexAriCanonicalJsonIntegrity,
  stringifyChannexAriCanonicalJson,
} from "./channex-ari-canonical-json.policy";

test("produces identical integrity regardless of object key order", () => {
  const original = {
    values: [
      {
        property_id: "property-1",
        room_type_id: "room-1",
        date: "2026-08-01",
        availability: 1,
      },
    ],
  };

  const postgresJsonbOrder = {
    values: [
      {
        date: "2026-08-01",
        property_id: "property-1",
        availability: 1,
        room_type_id: "room-1",
      },
    ],
  };

  assert.deepEqual(
    calculateChannexAriCanonicalJsonIntegrity(original),
    calculateChannexAriCanonicalJsonIntegrity(
      postgresJsonbOrder
    )
  );
});

test("sorts nested object keys while preserving array order", () => {
  assert.equal(
    stringifyChannexAriCanonicalJson({
      z: 1,
      nested: {
        b: 2,
        a: 1,
      },
      array: [
        {
          d: 4,
          c: 3,
        },
        2,
        1,
      ],
      a: 0,
    }),
    '{"a":0,"array":[{"c":3,"d":4},2,1],"nested":{"a":1,"b":2},"z":1}'
  );
});

test("calculates bytes and SHA-256 from the same canonical string", () => {
  const value = {
    b: "two",
    a: "one",
  };

  const integrity =
    calculateChannexAriCanonicalJsonIntegrity(value);

  assert.equal(
    integrity.serialized,
    '{"a":"one","b":"two"}'
  );

  assert.equal(
    integrity.payloadBytes,
    Buffer.byteLength(integrity.serialized, "utf8")
  );

  assert.match(
    integrity.payloadHash,
    /^[a-f0-9]{64}$/
  );
});

test("rejects unsupported JSON values and invalid numbers", () => {
  assert.throws(
    () => stringifyChannexAriCanonicalJson(undefined),
    /CHANNEX_ARI_CANONICAL_JSON_VALUE_UNSUPPORTED/
  );

  assert.throws(
    () => stringifyChannexAriCanonicalJson(1n),
    /CHANNEX_ARI_CANONICAL_JSON_VALUE_UNSUPPORTED/
  );

  assert.throws(
    () => stringifyChannexAriCanonicalJson(Number.NaN),
    /CHANNEX_ARI_CANONICAL_JSON_NUMBER_INVALID/
  );

  assert.throws(
    () =>
      stringifyChannexAriCanonicalJson(
        Number.POSITIVE_INFINITY
      ),
    /CHANNEX_ARI_CANONICAL_JSON_NUMBER_INVALID/
  );
});

test("rejects circular references and unsupported object prototypes", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.throws(
    () => stringifyChannexAriCanonicalJson(circular),
    /CHANNEX_ARI_CANONICAL_JSON_CIRCULAR_REFERENCE/
  );

  assert.throws(
    () => stringifyChannexAriCanonicalJson(new Date()),
    /CHANNEX_ARI_CANONICAL_JSON_OBJECT_UNSUPPORTED/
  );
});

test("allows shared non-circular references", () => {
  const shared = {
    b: 2,
    a: 1,
  };

  assert.equal(
    stringifyChannexAriCanonicalJson({
      first: shared,
      second: shared,
    }),
    '{"first":{"a":1,"b":2},"second":{"a":1,"b":2}}'
  );
});
