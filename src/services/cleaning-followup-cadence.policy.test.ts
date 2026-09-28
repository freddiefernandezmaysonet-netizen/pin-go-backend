import assert from "node:assert/strict";
import test from "node:test";
import { CLEANING_FOLLOWUP_CLAIM_INTERVAL_MS, shouldRunCleaningFollowupClaimCycle } from "./cleaning-followup-cadence.policy.js";
test("runs immediately on worker boot",()=>assert.equal(shouldRunCleaningFollowupClaimCycle({nowMs:1000,lastRunAtMs:null}),true));
test("does not query every reservation-worker tick",()=>assert.equal(shouldRunCleaningFollowupClaimCycle({nowMs:50_000,lastRunAtMs:10_000}),false));
test("runs at the one-minute boundary",()=>assert.equal(shouldRunCleaningFollowupClaimCycle({nowMs:10_000+CLEANING_FOLLOWUP_CLAIM_INTERVAL_MS,lastRunAtMs:10_000}),true));
