import assert from "node:assert/strict";
import test from "node:test";
import {
  otaOperationalIssueKey,
  reconcileOtaOperationalDeliveryAttention,
} from "./ota-operational-attention.service.js";
import type { upsertOperationalIssue, reopenOperationalIssue } from "../apms/operational-intelligence.service.js";

const now = new Date("2026-10-07T21:00:00Z");
const input = {
  organizationId: "org", propertyId: "prop",
  reservationId: "res", reservationNumber: "PG-SYNTHETIC",
  type: "GUEST_ACCESS_PASSCODE" as const,
  ok: false, error: "OTA_OPERATIONAL_THREAD_MISSING_OR_AMBIGUOUS", now,
};

function fixture() {
  let current: any = null;
  const saved: any[] = [], reopenCalls: any[] = [];
  const db: any = {
    operationalIssue: {
      findUnique: async () => current,
    },
  };
  const upsert = (async (_db: unknown, payload: any) => {
    saved.push(payload);
    current = {
      workflowState: payload.workflowState,
      metadata: payload.metadata,
      firstDetectedAt: current?.firstDetectedAt ?? now,
    };
    return { operationalKey: payload.operationalKey };
  }) as typeof upsertOperationalIssue;
  const reopen = (async (_db: unknown, payload: any) => {
    reopenCalls.push(payload);
    current = {
      ...current,
      workflowState: payload.workflowState,
      metadata: payload.metadata,
    };
  }) as typeof reopenOperationalIssue;
  return {
    db, saved, reopenCalls,
    deps: { upsert, reopen },
    setCurrent(value: unknown) { current = value; },
  };
}

test("missing Channex booking thread creates one critical host Mission Control issue", async () => {
  const f = fixture();
  assert.equal(await reconcileOtaOperationalDeliveryAttention(f.db, input, f.deps), "CREATED");
  assert.equal(f.saved.length, 1);
  const issue = f.saved[0];
  assert.equal(issue.operationalKey, otaOperationalIssueKey(input));
  assert.equal(issue.workflowState, "ACTION_REQUIRED");
  assert.equal(issue.visibility, "HOST");
  assert.equal(issue.actionTarget, "MESSAGING");
  assert.equal(issue.severity, "CRITICAL");
  assert.match(issue.recommendedAction, /Channex/);
  assert.doesNotMatch(JSON.stringify(issue), /guest@example|987654|guestPhone|Twilio token/);
});

test("repeated same failure is idempotent and generates no extra issue writes", async () => {
  const f = fixture();
  assert.equal(await reconcileOtaOperationalDeliveryAttention(f.db, input, f.deps), "CREATED");
  assert.equal(await reconcileOtaOperationalDeliveryAttention(f.db, input, f.deps), "UNCHANGED");
  assert.equal(f.saved.length, 1);
});

test("not-due and unreleased access do not generate false host alerts", async () => {
  const f = fixture();
  for (const error of ["OTA_OPERATIONAL_PRECHECKIN_NOT_DUE", "OTA_OPERATIONAL_ACCESS_NOT_RELEASED"]) {
    assert.equal(await reconcileOtaOperationalDeliveryAttention(
      f.db, { ...input, error }, f.deps,
    ), "UNCHANGED");
  }
  assert.equal(f.saved.length, 0);
});

test("uncertain provider outcome advises inspection, never blind resend", async () => {
  const f = fixture();
  await reconcileOtaOperationalDeliveryAttention(
    f.db, { ...input, error: "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN" }, f.deps,
  );
  assert.match(f.saved[0].recommendedAction, /before any manual resend/);
  assert.equal(f.saved[0].nextAutomaticStep, null);
});

test("Channex acceptance resolves prior operational delivery gap", async () => {
  const f = fixture();
  await reconcileOtaOperationalDeliveryAttention(f.db, input, f.deps);
  assert.equal(await reconcileOtaOperationalDeliveryAttention(
    f.db, { ...input, ok: true, error: null }, f.deps,
  ), "RESOLVED");
  assert.equal(f.saved.length, 2);
  assert.equal(f.saved[1].workflowState, "RESOLVED");
  assert.equal(f.saved[1].resolutionCode, "OTA_CHANNEX_PROVIDER_ACCEPTED");
});

test("same-stay later failure uses approved reopen transition instead of illegal resolved upsert", async () => {
  const f = fixture();
  await reconcileOtaOperationalDeliveryAttention(f.db, input, f.deps);
  await reconcileOtaOperationalDeliveryAttention(f.db, { ...input, ok: true }, f.deps);
  assert.equal(await reconcileOtaOperationalDeliveryAttention(
    f.db, { ...input, error: "OTA_OPERATIONAL_PREFLIGHT_FAILED" }, f.deps,
  ), "REOPENED");
  assert.equal(f.reopenCalls.length, 1);
  assert.equal(f.saved[2].workflowState, "ACTION_REQUIRED");
});
