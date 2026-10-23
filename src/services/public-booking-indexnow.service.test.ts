import assert from "node:assert/strict";
import test from "node:test";
import { capturePublicBookingUrls, indexNowEnabled, publicIndexNowUrls, submitIndexNow } from "./public-booking-indexnow.service.js";

test("only public booking URLs on the canonical host can leave the application", () => {
  const good = "https://pin-ngo.com/book/host/villa";
  assert.deepEqual(publicIndexNowUrls([good, good, "https://pin-ngo.com/book/host", "https://evil.test/book/host/villa",
    "https://pin-ngo.com/booking/manage/private-token", good + "?token=private", "https://app.pin-ngo.com/book/host/villa", "invalid"]),
    [good, "https://pin-ngo.com/book/host"]);
});
test("submission preserves old and new slugs, deduplicates and retries transient errors", async () => {
  let calls = 0;
  const before = "https://pin-ngo.com/book/host/old";
  const after = "https://pin-ngo.com/book/host/new";
  const send = (async (_url: unknown, options: any) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.host, "pin-ngo.com");
    assert.deepEqual(payload.urlList, [before, after]);
    return new Response(null, { status: ++calls === 1 ? 503 : 202 });
  }) as typeof fetch;
  assert.equal(await submitIndexNow([before, after, after], send, async () => {}), true);
  assert.equal(calls, 2);
});
test("permanent failure stops retries and reports failure without throwing", async () => {
  let calls = 0;
  assert.equal(await submitIndexNow(["https://pin-ngo.com/book/host/villa"], (async () => {
    calls++; return new Response(null, { status: 403 });
  }) as typeof fetch), false);
  assert.equal(calls, 1);
});
test("network failure is bounded to three attempts", async () => {
  let calls = 0;
  assert.equal(await submitIndexNow(["https://pin-ngo.com/book/host/villa"], (async () => {
    calls++; throw new Error("offline");
  }) as typeof fetch, async () => {}), false);
  assert.equal(calls, 3);
});
test("disabled and nonproduction environments do not query or submit", async () => {
  const old = { enabled: process.env.INDEXNOW_ENABLED, node: process.env.NODE_ENV };
  try {
    process.env.INDEXNOW_ENABLED = "false"; process.env.NODE_ENV = "production";
    assert.equal(indexNowEnabled(), false);
    assert.deepEqual(await capturePublicBookingUrls({} as any, "org"), []);
    process.env.INDEXNOW_ENABLED = "true"; process.env.NODE_ENV = "test";
    assert.equal(indexNowEnabled(), false);
  } finally { if (old.enabled === undefined) delete process.env.INDEXNOW_ENABLED; else process.env.INDEXNOW_ENABLED = old.enabled;
    if (old.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old.node; }
});
test("captures only published non-test inventory and skips custom brands", async () => {
  const old = { enabled: process.env.INDEXNOW_ENABLED, node: process.env.NODE_ENV };
  process.env.INDEXNOW_ENABLED = "true"; process.env.NODE_ENV = "production";
  try {
    const db = { property: { findMany: async (q: any) => {
      assert.deepEqual(q.where, { organizationId: "org", id: "p", status: "ACTIVE", isPublicBookable: true,
        isTestProperty: false, slug: { not: null }, organization: { publicBookingEnabled: true, slug: { not: null } } });
      return [{ slug: "villa & mar", organization: { slug: "host" } }];
    } } } as any;
    assert.deepEqual(await capturePublicBookingUrls(db, "org", "p", (async () => ({kind:"PIN_GO_STANDARD"})) as any),
      ["https://pin-ngo.com/book/host", "https://pin-ngo.com/book/host/villa%20%26%20mar"]);
    assert.deepEqual(await capturePublicBookingUrls({} as any, "org", "p", (async () => ({kind:"CUSTOM_BRAND"})) as any), []);
  } finally { if (old.enabled === undefined) delete process.env.INDEXNOW_ENABLED; else process.env.INDEXNOW_ENABLED = old.enabled;
    if (old.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old.node; }
});
