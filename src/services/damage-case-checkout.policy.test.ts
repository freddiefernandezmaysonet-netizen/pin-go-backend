import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isDamageCaseAfterCheckout } from "./damage-case-checkout.policy.js";
import type { PrismaClient } from "@prisma/client";
import { notifyGuestOfApprovedDamageCase } from "./damage-case-guest-notification.service.js";
import { notifyGuestOfNoChargeDamageCaseClosure } from "./damage-case-guest-closure-notification.service.js";
import { notifyHostOfGuestDamageCaseResponse } from "./damage-case-host-response-notification.service.js";

test("fails closed until strictly after checkout, including missing or invalid timestamps", () => {
  const checkout = new Date("2026-09-23T11:00:00-04:00");
  assert.equal(isDamageCaseAfterCheckout(checkout, new Date("2026-09-23T14:59:59.999Z")), false);
  assert.equal(isDamageCaseAfterCheckout(checkout, new Date("2026-09-23T15:00:00Z")), false);
  assert.equal(isDamageCaseAfterCheckout(checkout, new Date("2026-09-23T15:00:00.001Z")), true);
  for (const value of [null, undefined, "2026-01-01", new Date(NaN)]) {
    assert.equal(isDamageCaseAfterCheckout(value), false);
  }
  assert.equal(isDamageCaseAfterCheckout(checkout, new Date(NaN)), false);
});

test("a current extended checkout blocks a previously eligible reservation", () => {
  const now = new Date("2026-09-23T16:00:00Z");
  assert.equal(isDamageCaseAfterCheckout(new Date("2026-09-23T15:00:00Z"), now), true);
  assert.equal(isDamageCaseAfterCheckout(new Date("2026-09-24T15:00:00Z"), now), false);
});

test("real notification entrypoints exit before writes, token changes or delivery when stay is extended", async () => {
  for (const notify of [notifyGuestOfApprovedDamageCase, notifyGuestOfNoChargeDamageCaseClosure, notifyHostOfGuestDamageCaseResponse]) {
    let reads = 0;
    const prisma = {
      damageCase: { findUnique: async () => {
        reads += 1;
        return {
          id: "synthetic-case",
          status: notify === notifyGuestOfNoChargeDamageCaseClosure ? "CLOSED_NO_CHARGE" : "GUEST_NOTIFICATION_PENDING",
          guestResponse: "ACCEPTED", guestNotifiedAt: new Date(0),
          reservation: { checkOut: new Date(Date.now() + 86_400_000) },
        };
      } },
      // No other methods: touching logs, tokens or destinations must fail the test.
    } as unknown as PrismaClient;
    assert.deepEqual(await notify({ prisma, damageCaseId: "synthetic-case" }), {
      ok: false, code: "DAMAGE_CASE_CHECKOUT_REQUIRED",
    });
    assert.equal(reads, 1);
  }
});

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("approval gate precedes mutation and notification, while documentation stays ungated", () => {
  const routes = source("../routes/dashboard.damage-cases.routes.ts");
  const approval = routes.slice(routes.indexOf('router.post("/api/dashboard/damage-cases/:id/approve"'), routes.indexOf('router.post("/api/dashboard/damage-cases/:id/close-no-charge"'));
  assert.match(approval, /checkOut: true/);
  assert.ok(approval.indexOf("isDamageCaseAfterCheckout") < approval.indexOf("prisma.damageCase.update"));
  assert.match(approval, /status\(409\).*DAMAGE_CASE_CHECKOUT_REQUIRED/);
  const documentation = routes.slice(routes.indexOf('router.post("/api/dashboard/reservations/'), routes.indexOf('router.post("/api/dashboard/damage-cases/:id/approve"'));
  assert.doesNotMatch(documentation, /isDamageCaseAfterCheckout/);
});

test("all initial notification paths gate before MessageLog access or sends", () => {
  for (const file of ["damage-case-guest-notification.service.ts", "damage-case-guest-closure-notification.service.ts", "damage-case-host-response-notification.service.ts"]) {
    const code = source(`./${file}`);
    const guard = code.indexOf("if (!isDamageCaseAfterCheckout");
    assert.ok(guard > 0 && guard < code.indexOf(".messageLog.findFirst"), file);
    assert.match(code, /checkOut: true/);
  }
});

test("guest read model hides cases and response API blocks mutations before checkout", () => {
  assert.match(source("./guest-cancellation.service.ts"), /const guestVisibleDamageCase =\s*isDamageCaseAfterCheckout\(reservation.checkOut\) &&/);
  const response = source("./damage-case-guest-response.service.ts");
  assert.match(response, /checkOut: true/);
  assert.ok(response.indexOf("if (!isDamageCaseAfterCheckout") < response.indexOf("prisma.damageCase.updateMany"));
});

test("retry gates defer without throwing, consuming attempts or starving following pages", () => {
  const worker = source("../workers/message.retry.worker.ts");
  for (const name of ["processPropertyProtectionDamageNoticeRetries", "processPropertyProtectionGuestClosureRetries", "processPropertyProtectionHostResponseRetries"]) {
    const start = worker.indexOf(`async function ${name}`);
    const end = worker.indexOf("\nasync function ", start + 1);
    const code = worker.slice(start, end === -1 ? undefined : end);
    assert.match(code, /checkOut: true/);
    assert.match(code, /if \(!isDamageCaseAfterCheckout\(damageCase.reservation.checkOut\)\) continue;/);
    assert.match(code, /\.\.\.damageRetryPage/);
    assert.match(code, /advanceDamageRetryPage/);
  }
});
