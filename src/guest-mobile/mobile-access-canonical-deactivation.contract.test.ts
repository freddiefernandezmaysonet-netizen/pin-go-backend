import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const facade = await fs.readFile(new URL("./mobile-access-canonical-deactivation.service.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");
const reconcile = await fs.readFile(new URL("../services/reservation.reconcile.service.ts", import.meta.url), "utf8");
const expire = await fs.readFile(new URL("../workers/access-grant-expire.worker.ts", import.meta.url), "utf8");

test("canonical facade revokes passcode before any mobile work", () => {
  const canonicalAt = facade.indexOf("await deactivateGrant");
  const flagAt = facade.indexOf("MOBILE_ACCESS_EKEY_ENABLED");
  const mobileAt = facade.indexOf("await reconcileMobileAccessRevocationSidecar");
  assert.ok(canonicalAt >= 0 && flagAt > canonicalAt && mobileAt > flagAt);
});

test("exactly the three canonical lifecycle callers use Guest deactivation facade", () => {
  for (const source of [worker, reconcile, expire]) {
    assert.match(source, /deactivateGuestAccess/);
    assert.doesNotMatch(source, /await deactivateGrant\(/);
  }
});

test("feature flag keeps migrated callers behaviorally passcode-only by default", () => {
  assert.match(facade, /MOBILE_ACCESS_EKEY_ENABLED !== "true"/);
  assert.match(facade, /status: "DISABLED"/);
});

test("legacy deactivateGrant implementations are not imported by migrated callers", () => {
  for (const source of [worker, reconcile, expire]) {
    assert.doesNotMatch(source, /access\.service|ttlock\.grants\.service|grantActivation\.service/);
  }
});
