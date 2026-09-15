import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./deviceGateway.routes.ts", import.meta.url),
  "utf8"
);

test("legacy gateway refresh route is not exposed", () => {
  assert.equal(
    source.includes("/api/dev/locks/:lockId/gateway/refresh"),
    false
  );
  assert.equal(source.includes("ttlockFetchGateway"), false);
  assert.equal(source.includes("healthStatus: \"HEALTHY\""), false);
});
