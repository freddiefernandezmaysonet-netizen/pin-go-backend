import assert from "node:assert/strict";
import test from "node:test";
import { hostScopeEnabled, parseHostCommand, sealHostContent, openHostContent } from "./host-incident-policy.js";
const env = { PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: "organization-1",
  PIN_AI_HOST_INCIDENT_RESERVATION_IDS: "reservation-1", PIN_AI_HOST_INCIDENT_KEY_ID: "test-v1",
  PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ "test-v1": "ab".repeat(32) }) };
test("host scope requires independent flag and both explicit allowlists", () => {
  assert.equal(hostScopeEnabled(env, "organization-1", "reservation-1"), true);
  for (const e of [{}, { ...env, PIN_AI_HOST_INCIDENT_ENABLED: "false" }, { ...env, PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: "*" },
    { ...env, PIN_AI_HOST_INCIDENT_RESERVATION_IDS: "" }]) assert.equal(hostScopeEnabled(e, "organization-1", "reservation-1"), false);
  assert.equal(hostScopeEnabled(env, "organization-2", "reservation-1"), false);
  assert.equal(hostScopeEnabled(env, "organization-1", "reservation-2"), false);
});
test("commands reject model-selected scopes, empty outcomes and invalid versions", () => {
  const valid = { operation: "PUBLISH", text: "Host update", requestId: "request-123456789", expectedVersion: 0 };
  assert.deepEqual(parseHostCommand(valid), valid);
  for (const value of [null, [], { ...valid, organizationId: "other" }, { ...valid, operation: "REFUND" },
    { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 0.2 }, { ...valid, expectedVersion: "0" },
    { ...valid, text: " " }, { ...valid, text: "a".repeat(4001) }, { ...valid, operation: "ACKNOWLEDGE" }]) {
    assert.throws(() => parseHostCommand(value), /INVALID_REQUEST/);
  }
});
test("encrypted content is audience/scope-bound, authenticated and key-versioned", () => {
  const aad = "org:thread:1:INTERNAL", value = sealHostContent(env, aad, "Private host note");
  assert.doesNotMatch(value, /Private host note/);
  assert.equal(openHostContent(env, aad, value), "Private host note");
  for (const other of ["other:thread:1:INTERNAL", "org:thread:1:GUEST", "org:thread:2:INTERNAL"]) {
    assert.throws(() => openHostContent(env, other, value), /UNAVAILABLE/);
  }
  const changed = JSON.parse(value); changed.tag = "00".repeat(16);
  assert.throws(() => openHostContent(env, aad, JSON.stringify(changed)), /UNAVAILABLE/);
  assert.throws(() => openHostContent({}, aad, value), /UNAVAILABLE/);
  assert.throws(() => sealHostContent({}, aad, "x"), /UNAVAILABLE/);
  const rotated = { ...env, PIN_AI_HOST_INCIDENT_KEY_ID: "test-v2", PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ "test-v1": "ab".repeat(32), "test-v2": "cd".repeat(32) }) };
  assert.equal(openHostContent(rotated, aad, value), "Private host note");
  assert.equal(openHostContent(rotated, aad, sealHostContent(rotated, aad, "new")), "new");
});
