import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("./dashboard.health.routes.ts", import.meta.url),
  "utf8"
);

test("gateway health read model is tenant-scoped and provider-call free", () => {
  assert.match(
    source,
    /router\.get\("\/gateways"/
  );
  assert.match(
    source,
    /organizationId:\s*orgId/
  );
  assert.match(
    source,
    /mappedLockCount:\s*gateway\.locks\.length/
  );
  assert.doesNotMatch(
    source,
    /ttlockFetch|fetchGatewayStatus|api\.sciener\.com|gateway\/list/
  );
});
