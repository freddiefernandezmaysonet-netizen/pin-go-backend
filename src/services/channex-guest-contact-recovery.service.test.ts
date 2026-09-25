import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  classifyGuestContact,
  guestContactRecoveryOperationalKey,
  syncChannexGuestContactRecovery,
} from "./channex-guest-contact-recovery.service";

function fakePrisma(reservation: any, issue: any = null) {
  return {
    reservation: { findUnique: async () => reservation },
    operationalIssue: { findUnique: async () => issue },
  } as any;
}

test("classifies complete and partial guest contact deterministically", () => {
  assert.equal(classifyGuestContact({ guestEmail: "g@example.com", guestPhone: "+17875550123" }), "COMPLETE");
  assert.equal(classifyGuestContact({ guestEmail: null, guestPhone: "+17875550123" }), "EMAIL_MISSING");
  assert.equal(classifyGuestContact({ guestEmail: "g@example.com", guestPhone: null }), "PHONE_MISSING");
  assert.equal(classifyGuestContact({ guestEmail: null, guestPhone: null }), "BOTH_MISSING");
});

test("missing Channex contact creates one tenant-scoped host action identity", async () => {
  const calls: any[] = [];
  const reservation = {
    id: "res-1", reservationNumber: "PG-2026-1", guestName: "Guest",
    guestEmail: null, guestPhone: null, status: "ACTIVE", externalProvider: "CHANNEX",
    propertyId: "prop-1", property: { organizationId: "org-1" },
  };
  const deps = { upsert: async (_db: any, input: any) => { calls.push(input); return input; } };
  await syncChannexGuestContactRecovery(fakePrisma(reservation), "res-1", { guestEmail: null, guestPhone: null }, deps as any);
  await syncChannexGuestContactRecovery(fakePrisma(reservation, { id: "issue-1", workflowState: "ACTION_REQUIRED" }), "res-1", { guestEmail: null, guestPhone: null }, deps as any);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].operationalKey, guestContactRecoveryOperationalKey("res-1"));
  assert.equal(calls[1].operationalKey, calls[0].operationalKey);
  assert.equal(calls[0].organizationId, "org-1");
  assert.equal(calls[0].propertyId, "prop-1");
  assert.equal(calls[0].reservationId, "res-1");
  assert.equal(calls[0].workflowState, "ACTION_REQUIRED");
  assert.equal(calls[0].responsibleActor, "HOST");
  assert.deepEqual(calls[0].metadata.missingFields, ["EMAIL", "PHONE"]);
});

test("complete effective contact resolves only the contact-recovery operational key", async () => {
  const calls: any[] = [];
  const reservation = {
    id: "res-2", reservationNumber: "PG-2026-2", guestName: "Guest",
    guestEmail: "g@example.com", guestPhone: "+17875550123", status: "ACTIVE",
    externalProvider: "CHANNEX", propertyId: "prop-2", property: { organizationId: "org-2" },
  };
  await syncChannexGuestContactRecovery(
    fakePrisma(reservation, { id: "issue-2", workflowState: "ACTION_REQUIRED" }),
    "res-2",
    { guestEmail: "g@example.com", guestPhone: "+17875550123" },
    { upsert: async (_db: any, input: any) => { calls.push(input); return input; } } as any
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operationalKey, "GUEST_CONTACT_RECOVERY:res-2");
  assert.equal(calls[0].workflowState, "RESOLVED");
  assert.equal(calls[0].resolutionCode, "GUEST_CONTACT_AVAILABLE");
  assert.equal(calls[0].resolvedBy, "PIN_GO");
});

test("non-Channex reservations are not enrolled", async () => {
  let called = false;
  const reservation = {
    id: "res-3", externalProvider: "PIN_GO_DIRECT", propertyId: "prop-3",
    property: { organizationId: "org-3" },
  };
  const result = await syncChannexGuestContactRecovery(
    fakePrisma(reservation), "res-3", {},
    { upsert: async () => { called = true; } } as any
  );
  assert.equal(result.applicable, false);
  assert.equal(called, false);
});

test("Channex null revisions preserve previously recovered contact in both PMS update paths", async () => {
  const source = await readFile(new URL("./ingest.service.ts", import.meta.url), "utf8");
  assert.match(source, /input\.guestEmail == null[\s\S]*existingByPms\.guestEmail/);
  assert.match(source, /input\.guestPhone == null[\s\S]*existingByPms\.guestPhone/);
  assert.match(source, /input\.guestEmail == null[\s\S]*existingByIngestKey\.guestEmail/);
  assert.match(source, /input\.guestPhone == null[\s\S]*existingByIngestKey\.guestPhone/);
  assert.match(source, /syncChannexGuestContactRecovery\(prisma, result\.reservationId/);
});
