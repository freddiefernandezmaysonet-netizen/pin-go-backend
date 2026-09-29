import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const wrapper = await fs.readFile(new URL("./mobile-access-deactivation-wrapper.service.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");
const reconcile = await fs.readFile(new URL("../services/reservation.reconcile.service.ts", import.meta.url), "utf8");

test("canonical AccessGrant revoke completes before mobile flag or sidecar", () => {
  const canonicalAt = wrapper.indexOf("await deactivateGrant");
  const flagAt = wrapper.indexOf("MOBILE_ACCESS_EKEY_ENABLED");
  const sidecarAt = wrapper.indexOf("await reconcileMobileAccessRevocationSidecar");
  assert.ok(canonicalAt >= 0 && flagAt > canonicalAt && sidecarAt > flagAt);
});

test("mobile sidecar failure is absorbed after canonical revoke", () => {
  assert.match(wrapper, /catch \(error\)/);
  assert.match(wrapper, /status: "RECOVERY_REQUIRED"/);
  assert.doesNotMatch(wrapper, /catch \(error\)[\s\S]*throw error/);
});

test("mobile sidecar remains default-off", () => {
  assert.match(wrapper, /MOBILE_ACCESS_EKEY_ENABLED !== "true"/);
  assert.match(wrapper, /status: "DISABLED"/);
});

test("current production callers have not migrated to wrapper yet", () => {
  assert.doesNotMatch(worker, /deactivateGuestAccessWithMobileSidecar/);
  assert.doesNotMatch(reconcile, /deactivateGuestAccessWithMobileSidecar/);
});
