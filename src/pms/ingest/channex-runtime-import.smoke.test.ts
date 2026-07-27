import assert from "node:assert/strict";
import test from "node:test";

test("Channex booking lifecycle service exposes shared persistence and ACK boundaries", async () => {
  const module = await import("./channex-booking-lifecycle.service");

  assert.equal(
    typeof module.persistChannexBookingRevision,
    "function"
  );
  assert.equal(
    typeof module.acknowledgePersistedChannexBookingRevision,
    "function"
  );
  assert.equal(
    typeof module.processChannexBookingWebhookEventById,
    "function"
  );
});

test("PMS webhook dispatcher loads", async () => {
  const module = await import("./webhook.dispatcher");
  assert.equal(typeof module.dispatchPmsWebhookEventById, "function");
});

test("Distribution lifecycle read model loads", async () => {
  const module = await import(
    "../../apms/distribution-lifecycle-read-model.service"
  );
  assert.equal(typeof module.getDistributionLifecycleSnapshot, "function");
});

test("Distribution Mission Control middleware loads", async () => {
  const module = await import(
    "../../routes/dashboard.distribution-mission-control.middleware"
  );
  assert.equal(
    typeof module.dashboardDistributionMissionControlMiddleware,
    "function"
  );
});
