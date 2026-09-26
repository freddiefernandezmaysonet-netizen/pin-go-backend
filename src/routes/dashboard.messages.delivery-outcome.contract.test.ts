import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readMessagesRoute() {
  return readFile(
    new URL("./dashboard.messages.routes.ts", import.meta.url),
    "utf8"
  );
}

test("dashboard messages read model exposes provider delivery outcomes", async () => {
  const source = await readMessagesRoute();

  for (const field of [
    "providerDeliveryStatus",
    "providerStatusUpdatedAt",
    "providerErrorCode",
    "providerErrorMessage",
    "deliveredAt",
  ]) {
    assert.match(
      source,
      new RegExp(`${field}:\\s*item\\.${field}\\s*\\?\\?\\s*null`)
    );
  }
});

test("dashboard messages provider read model remains read-only", async () => {
  const source = await readMessagesRoute();
  const getStart = source.indexOf('router.get("/messages"');
  const retryStart = source.indexOf('router.post("/messages/:id/retry"');
  const getBlock = source.slice(getStart, retryStart);

  assert.ok(getStart >= 0);
  assert.ok(retryStart > getStart);
  assert.doesNotMatch(getBlock, /messageLog\.(?:update|updateMany|create|delete)/);
  assert.doesNotMatch(getBlock, /providerDeliveryStatus:\s*"/);
});
