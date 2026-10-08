import test from "node:test";
import assert from "node:assert/strict";
import { activationHash, loadCleanerActivation, activateCleanerAccount, requestCleanerAccount, issueCleanerActivation } from "./cleaner-account.service.js";
import { comparePassword } from "../lib/auth.js";

const now = new Date("2026-10-06T20:00:00Z");
const token = "a".repeat(48);
function fixture() {
  const staff: any = { id: "staff", organizationId: "org", fullName: "Maria Cleaner", isActive: true, dashboardUserId: null, cleanerAccountEmail: "maria@example.com", cleanerAccountRequestedAt: now, preferredLanguage: "es" };
  const activation: any = { id: "activation", staffMemberId: staff.id, confirmationId: "offer", email: staff.cleanerAccountEmail, requestedAt: now, tokenHash: activationHash(token), expiresAt: new Date(now.getTime() + 100000), consumedAt: null, staffMember: staff };
  const offer: any = { id: "offer", staffMemberId: staff.id, propertyId: "property", reservationId: "reservation", status: "PENDING" };
  const users: any[] = [];
  let queue = Promise.resolve();
  const db: any = {
    $queryRaw: async () => [{ id: staff.id }],
    cleaningWork: { findFirst: async () => offer.workClosed ? { id: "work" } : null },
    staffMember: {
      findFirst: async ({ where }: any) => where.id === staff.id && where.organizationId === staff.organizationId && staff.isActive ? staff : null,
      findUnique: async ({ where }: any) => where.id === staff.id ? staff : null,
      update: async ({ data }: any) => Object.assign(staff, data),
    },
    cleaningConfirmation: {
      findUnique: async ({ where }: any) => where.id === offer.id ? offer : null,
      findFirst: async () => ["PENDING", "CONFIRMED"].includes(offer.status) ? offer : null,
    },
    reservation: { findFirst: async ({ where }: any) => where.property.organizationId === staff.organizationId ? { id: "reservation" } : null },
    dashboardUser: {
      findUnique: async ({ where }: any) => users.find(u => u.email === where.email) ?? null,
      create: async ({ data }: any) => { const user = { id: "user", ...data }; users.push(user); return user; },
    },
    cleanerAccountActivation: {
      findUnique: async ({ where }: any) => where.tokenHash === activation.tokenHash ? activation : null,
      create: async ({ data }: any) => Object.assign(activation, data),
      updateMany: async ({ data }: any) => { Object.assign(activation, data); return { count: 1 }; },
      deleteMany: async () => { activation.consumedAt = now; },
    },
    $transaction: (fn: any) => { const result = queue.then(() => fn(db)); queue = result.catch(() => {}); return result; },
  };
  return { db, staff, activation, offer, users };
}
test("a cleaning offer token is not an activation capability", async () => {
  const { db } = fixture();
  await assert.rejects(loadCleanerActivation(db, "old-cleaning-offer", now), /ACTIVATION_INVALID/);
  await assert.rejects(loadCleanerActivation(db, "b".repeat(48), now), /ACTIVATION_INVALID/);
});
for (const state of ["expired", "consumed", "archived", "linked", "email-changed", "request-changed", "offer-expired", "work-reassigned"] as const) {
  test(`activation rejects ${state}`, async () => {
    const f = fixture();
    if (state === "expired") f.activation.expiresAt = now;
    if (state === "consumed") f.activation.consumedAt = now;
    if (state === "archived") f.staff.isActive = false;
    if (state === "linked") f.staff.dashboardUserId = "other-user";
    if (state === "email-changed") f.staff.cleanerAccountEmail = "other@example.com";
    if (state === "request-changed") f.staff.cleanerAccountRequestedAt = new Date(now.getTime() + 1);
    if (state === "offer-expired") f.offer.status = "EXPIRED";
    if (state === "work-reassigned") f.offer.workClosed = true;
    await assert.rejects(loadCleanerActivation(f.db, token, now), /ACTIVATION_INVALID/);
    assert.equal(f.users.length, 0);
  });
}
test("activation creates a restricted account, links existing Staff and consumes the capability", async () => {
  const f = fixture();
  await activateCleanerAccount(f.db, token, "MARIA@example.com", "FreshCleaning!83", now);
  assert.equal(f.users[0].role, "CLEANER");
  assert.equal(f.users[0].organizationId, f.staff.organizationId);
  assert.equal(f.staff.dashboardUserId, "user");
  assert.equal(await comparePassword("FreshCleaning!83", f.users[0].passwordHash), true);
  assert.equal(f.activation.consumedAt, now);
  await assert.rejects(activateCleanerAccount(f.db, token, "maria@example.com", "FreshCleaning!83", now), /ACTIVATION_INVALID/);
});
test("simultaneous activations yield only one account", async () => {
  const f = fixture();
  const results = await Promise.allSettled([1, 2].map(() => activateCleanerAccount(f.db, token, "maria@example.com", "FreshCleaning!83", now)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.users.length, 1);
});
test("email mismatch and weak password do not create an account", async () => {
  const f = fixture();
  await assert.rejects(activateCleanerAccount(f.db, token, "wrong@example.com", "FreshCleaning!83", now), /EMAIL_MISMATCH/);
  await assert.rejects(activateCleanerAccount(f.db, token, "maria@example.com", "short", now), /PASSWORD_POLICY/);
  assert.equal(f.users.length, 0);
});
test("an existing email is never repurposed or granted a new role", async () => {
  const f = fixture();
  f.users.push({ id: "existing", email: "maria@example.com", role: "ADMIN" });
  await assert.rejects(activateCleanerAccount(f.db, token, "maria@example.com", "FreshCleaning!83", now), /EMAIL_ALREADY_REGISTERED/);
  assert.equal(f.users[0].role, "ADMIN");
  assert.equal(f.staff.dashboardUserId, null);
});
test("host enrollment cannot target Staff in another organization", async () => {
  const f = fixture();
  await assert.rejects(requestCleanerAccount(f.db, "other-org", "staff", "maria@example.com", now), /STAFF_NOT_FOUND/);
});
test("only an enrolled unlinked active Staff receives a separate capability in a new offer", async () => {
  const f = fixture();
  const issued = await issueCleanerActivation(f.db, "offer", now);
  assert.match(issued!, /^[a-f0-9]{48}$/);
  assert.notEqual(issued, f.offer.token);
  assert.equal(f.activation.tokenHash, activationHash(issued!));
  f.staff.dashboardUserId = "user";
  assert.equal(await issueCleanerActivation(f.db, "offer", now), null);
});
