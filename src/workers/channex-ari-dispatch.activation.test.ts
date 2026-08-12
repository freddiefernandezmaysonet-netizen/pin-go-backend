import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannexAriDispatchActivation } from "./channex-ari-dispatch.activation";

test("defaults to disabled when the activation variable is absent or blank", () => {
  for (const rawValue of [undefined, "", "   ", "\t\n"]) {
    const env = {
      ...(rawValue === undefined
        ? {}
        : { CHANNEX_ARI_DISPATCH_ENABLED: rawValue }),
    } as NodeJS.ProcessEnv;

    assert.deepEqual(resolveChannexAriDispatchActivation(env), {
      enabled: false,
      source: "DEFAULT_DISABLED",
      rawValue: null,
    });
  }
});

test("enables dispatch only for supported explicit truthy values", () => {
  for (const rawValue of [
    "1",
    "true",
    "TRUE",
    "True",
    "yes",
    "YES",
    "on",
    "ON",
    "  true  ",
  ]) {
    assert.deepEqual(
      resolveChannexAriDispatchActivation({
        CHANNEX_ARI_DISPATCH_ENABLED: rawValue,
      } as NodeJS.ProcessEnv),
      {
        enabled: true,
        source: "EXPLICIT",
        rawValue: rawValue.trim(),
      }
    );
  }
});

test("disables dispatch for supported explicit falsy values", () => {
  for (const rawValue of [
    "0",
    "false",
    "FALSE",
    "False",
    "no",
    "NO",
    "off",
    "OFF",
    "  false  ",
  ]) {
    assert.deepEqual(
      resolveChannexAriDispatchActivation({
        CHANNEX_ARI_DISPATCH_ENABLED: rawValue,
      } as NodeJS.ProcessEnv),
      {
        enabled: false,
        source: "EXPLICIT",
        rawValue: rawValue.trim(),
      }
    );
  }
});

test("rejects unsupported activation values with a stable error contract", () => {
  for (const rawValue of [
    "enabled",
    "disabled",
    "2",
    "-1",
    "null",
    "undefined",
    "maybe",
  ]) {
    assert.throws(
      () =>
        resolveChannexAriDispatchActivation({
          CHANNEX_ARI_DISPATCH_ENABLED: rawValue,
        } as NodeJS.ProcessEnv),
      /CHANNEX_ARI_DISPATCH_ENABLED_INVALID: expected true\/false, 1\/0, yes\/no, or on\/off/
    );
  }
});

test("reads only the dispatch activation variable and does not mutate the environment input", () => {
  const env = {
    CHANNEX_ARI_DISPATCH_ENABLED: "on",
    CHANNEX_GLOBAL_FEED_ENABLED: "off",
    CHANNEX_API_KEY: "must-not-be-read-or-returned",
  } as NodeJS.ProcessEnv;
  const before = { ...env };

  const result = resolveChannexAriDispatchActivation(env);

  assert.deepEqual(result, {
    enabled: true,
    source: "EXPLICIT",
    rawValue: "on",
  });
  assert.deepEqual(env, before);
  assert.equal(JSON.stringify(result).includes("must-not-be-read-or-returned"), false);
});
