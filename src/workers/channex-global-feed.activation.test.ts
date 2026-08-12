import assert from "node:assert/strict";
import test from "node:test";
import { resolveChannexGlobalFeedActivation } from "./channex-global-feed.activation";

test("global Channex feed is disabled by default", () => {
  assert.deepEqual(resolveChannexGlobalFeedActivation({}), {
    enabled: false,
    source: "DEFAULT_DISABLED",
    rawValue: null,
  });
});

for (const value of ["1", "true", "TRUE", "yes", "YES", "on", " ON "]) {
  test(`global Channex feed accepts enabled value ${JSON.stringify(value)}`, () => {
    assert.deepEqual(
      resolveChannexGlobalFeedActivation({
        CHANNEX_GLOBAL_FEED_ENABLED: value,
      }),
      {
        enabled: true,
        source: "EXPLICIT",
        rawValue: value.trim(),
      }
    );
  });
}

for (const value of ["0", "false", "FALSE", "no", "NO", "off", " OFF "]) {
  test(`global Channex feed accepts disabled value ${JSON.stringify(value)}`, () => {
    assert.deepEqual(
      resolveChannexGlobalFeedActivation({
        CHANNEX_GLOBAL_FEED_ENABLED: value,
      }),
      {
        enabled: false,
        source: "EXPLICIT",
        rawValue: value.trim(),
      }
    );
  });
}

for (const value of ["enabled", "disabled", "2", "-1", "maybe", "null"]) {
  test(`global Channex feed rejects invalid value ${JSON.stringify(value)}`, () => {
    assert.throws(
      () =>
        resolveChannexGlobalFeedActivation({
          CHANNEX_GLOBAL_FEED_ENABLED: value,
        }),
      /CHANNEX_GLOBAL_FEED_ENABLED_INVALID/
    );
  });
}
