import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./dashboard.organization.route.ts", import.meta.url),
  "utf8"
);

test("organization route no longer exposes legacy channel distribution", () => {
  assert.doesNotMatch(source, /channel-distribution/);
  assert.doesNotMatch(source, /PmsProvider\.CHANNEX/);
  assert.doesNotMatch(source, /connectedChannels/);
});

test("organization identity and direct booking settings remain available", () => {
  assert.match(source, /\/api\/dashboard\/organization/);
  assert.match(source, /publicBookingEnabled/);
  assert.match(source, /OrganizationUpdateInput/);
});
