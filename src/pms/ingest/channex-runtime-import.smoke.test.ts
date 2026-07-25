import assert from "node:assert/strict";
import test from "node:test";

import { getDistributionLifecycleSnapshot } from "../../apms/distribution-lifecycle-read-model.service";
import { dashboardDistributionMissionControlMiddleware } from "../../routes/dashboard.distribution-mission-control.middleware";
import { processChannexBookingWebhookEventById } from "./channex-booking-lifecycle.service";
import { processPmsWebhookEventById } from "./webhook.dispatcher";

test("Channex lifecycle runtime modules load with expected exports", () => {
  assert.equal(typeof processChannexBookingWebhookEventById, "function");
  assert.equal(typeof processPmsWebhookEventById, "function");
  assert.equal(typeof getDistributionLifecycleSnapshot, "function");
  assert.equal(typeof dashboardDistributionMissionControlMiddleware, "function");
});
