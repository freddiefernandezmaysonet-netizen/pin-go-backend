import assert from "node:assert/strict";
import test from "node:test";
import { decryptAccessCode } from "./access-code-crypto.service";
import { type CustomPasscodePlan, guestPhoneLastFour, provisionGuestPasscode } from "./guest-passcode-provision.service";
import { TTLockPasscodeError, type TtlockListedPasscode, ttlockCreatePasscode,
  ttlockHasAssociatedGateway, ttlockListPasscodes } from "../ttlock/ttlock.passcode";

process.env.ACCESS_CODE_ENC_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

function harness() {
  const input: Parameters<typeof provisionGuestPasscode>[0] = {
    lockId: 123, accessToken: "synthetic", name: "PinGo synthetic", startDate: 1_800_000_060_000,
    endDate: 1_800_001_260_000, phone: "+1 (202) 555-0125", mappedGateway: false, requireGateway: false,
    savedPlan: null, savePlan: async plan => { input.savedPlan = structuredClone(plan); }, codeReserved: async () => false,
  };
  const adds: any[] = [], timed: any[] = [];
  let inventory: TtlockListedPasscode[] = [];
  let random = 12345678;
  const deps = {
    gateway: async () => true, list: async () => inventory,
    custom: async (p: any) => { adds.push(p); return { keyboardPwdId: 77 }; },
    timed: async (p: any) => { timed.push(p); return { keyboardPwdId: 88, keyboardPwd: "87654321" }; },
    random: () => String(random++),
  };
  return { input, deps, adds, timed, run: () => provisionGuestPasscode(input, deps),
    plan: () => input.savedPlan as CustomPasscodePlan,
    inventory: (rows: TtlockListedPasscode[]) => { inventory = rows; },
    row: (changes: Partial<TtlockListedPasscode> = {}): TtlockListedPasscode => ({
      keyboardPwdId: 77, keyboardPwd: "0125", keyboardPwdName: input.name, keyboardPwdType: 3,
      startDate: input.startDate, endDate: input.endDate, status: 1, ...changes,
    }),
  };
}

test("phone suffix preserves zeros, accepts international formatting and excludes extension", () => {
  for (const phone of ["+1 (202) 555-0125", "+1-202-555-0125 ext. 999", "2025550125 x99"]) {
    assert.equal(guestPhoneLastFour(phone), "0125");
  }
  assert.equal(guestPhoneLastFour("+34 612 340 001"), "0001");
  for (const phone of [null, undefined, "", "1234", "202CALL0125", "+1234567890123456"]) {
    assert.equal(guestPhoneLastFour(phone), null);
  }
});

test("only a confirmed absence of gateway selects the existing Timed route", async () => {
  const h = harness(); h.deps.gateway = async () => false;
  assert.equal((await h.run()).provisioningMethod, "RANDOM_TIMED");
  assert.equal(h.adds.length, 0); assert.equal(h.input.savedPlan, null);
  assert.equal(h.timed[0].keyboardPwdType, 3);
  assert.equal(h.timed[0].startDate, h.input.startDate); assert.equal(h.timed[0].endDate, h.input.endDate);
  for (const key of ["mappedGateway", "requireGateway"] as const) {
    const known = harness(); known.input[key] = true; known.deps.gateway = async () => false;
    await assert.rejects(known.run(), /SAFE_TO_RETRY:GATEWAY_UNAVAILABLE/);
    assert.equal(known.timed.length + known.adds.length, 0);
  }
  const unknown = harness(); unknown.deps.gateway = async () => { throw new Error("offline"); };
  await assert.rejects(unknown.run(), /SAFE_TO_RETRY:GATEWAY_PRESENCE_UNCONFIRMED/);
  assert.equal(unknown.timed.length + unknown.adds.length, 0);
});

test("gateway uses the phone suffix, exact window and a durable encrypted candidate", async () => {
  const h = harness();
  const original = h.deps.custom;
  h.deps.custom = async p => {
    assert.equal(h.plan().state, "SUBMITTED"); assert.ok(h.plan().submittedAt);
    assert.equal(decryptAccessCode(h.plan().codeEnc), p.code);
    return original(p);
  };
  const pass = await h.run();
  assert.equal(pass.provisioningMethod, "CUSTOM_GATEWAY"); assert.equal(pass.keyboardPwd, "0125");
  assert.equal(h.plan().source, "PHONE_LAST4"); assert.equal(h.plan().state, "CONFIRMED");
  assert.equal(h.adds[0].addType, 2); assert.equal(h.adds[0].startDate, h.input.startDate);
  assert.equal(h.adds[0].endDate, h.input.endDate); assert.equal(h.timed.length, 0);
  assert.equal(Object.values(h.plan()).includes("0125"), false);
});

test("missing phone selects random Custom; occupied phone PIN selects a short suffix", async () => {
  for (const kind of ["phone", "inventory", "local"] as const) {
    const h = harness();
    if (kind === "phone") h.input.phone = null;
    if (kind === "inventory") h.inventory([h.row({ status: 2, endDate: 1000 })]);
    if (kind === "local") h.input.codeReserved = async code => code === "0125";
    const pass = await h.run();
    assert.equal(pass.keyboardPwd, kind === "phone" ? "12345678" : "01250");
    assert.equal(h.plan().source, kind === "phone" ? "RANDOM" : "PHONE_LAST4_SUFFIX");
    assert.equal(h.timed.length, 0); assert.equal(h.adds.length, 1);
  }
});

test("explicit duplicate rejection advances short candidates, bounded to three adds", async () => {
  const h = harness(); const original = h.deps.custom;
  h.deps.custom = async p => {
    if (p.code === "0125") { h.adds.push(p); throw new TTLockPasscodeError("redacted", -3002, "The passcode already exists"); }
    return original(p);
  };
  assert.equal((await h.run()).keyboardPwd, "01250");
  assert.equal(h.adds.length, 2); assert.equal(h.plan().source, "PHONE_LAST4_SUFFIX"); assert.equal(h.timed.length, 0);
  const full = harness(); full.deps.custom = async p => {
    full.adds.push(p); throw new TTLockPasscodeError("redacted", -3002, "The password already exists");
  };
  await assert.rejects(full.run(), /SAFE_TO_RETRY:CUSTOM_PASSCODE_CONFLICT_RETRIES_EXHAUSTED/);
  assert.deepEqual(full.adds.map(p => p.code), ["0125", "01250", "01251"]);
  assert.equal(full.timed.length, 0);
  const originalFull = full.deps.custom;
  full.input.phone = "+12025559876";
  full.deps.custom = async p => {
    if (p.code === "01252") { full.adds.push(p); return { keyboardPwdId: 77 }; }
    return originalFull(p);
  };
  assert.equal((await full.run()).keyboardPwd, "01252");
  assert.equal(full.adds.length, 4);
});

test("offline/busy explicit rejection keeps the same candidate even if the guest phone changes", async () => {
  for (const errorCode of [-2012, -3037]) {
    const h = harness(); const original = h.deps.custom;
    h.deps.custom = async () => { throw new TTLockPasscodeError("redacted", errorCode, "gateway unavailable"); };
    await assert.rejects(h.run(), /SAFE_TO_RETRY:CUSTOM_PASSCODE_PROVIDER_REJECTED/);
    assert.equal(h.plan().state, "READY"); h.input.phone = "+12025559876";
    h.deps.custom = original; assert.equal((await h.run()).keyboardPwd, "0125");
    assert.equal(h.timed.length, 0);
  }
});

test("lost or incomplete response cannot create another PIN; exact inventory evidence adopts the original", async () => {
  for (const response of ["timeout", "missing-id"]) {
    const h = harness(); h.deps.custom = async p => {
      h.adds.push(p);
      if (response === "timeout") throw new Error("lost response for secret PIN 0125");
      return { keyboardPwdId: 0 };
    };
    await assert.rejects(h.run(), error => /RESULT_AMBIGUOUS/.test(String(error)) && !String(error).includes("0125"));
    assert.equal(h.plan().state, "SUBMITTED");
    await assert.rejects(h.run(), /RESULT_AMBIGUOUS/); assert.equal(h.adds.length, 1);
    h.inventory([h.row()]);
    assert.equal((await h.run()).keyboardPwdId, 77); assert.equal(h.plan().state, "CONFIRMED");
    assert.equal(h.adds.length, 1); assert.equal(h.timed.length, 0);
    await h.run(); assert.equal(h.adds.length, 1);
  }
});

test("mismatched or duplicate inventory evidence cannot adopt an uncertain PIN", async () => {
  const changes = [{ keyboardPwdName: "another booking" }, { endDate: 999 }, { status: 4 }, { keyboardPwdType: 2 }];
  for (const change of [...changes, null]) {
    const h = harness(); h.deps.custom = async p => { h.adds.push(p); throw new Error("timeout"); };
    await assert.rejects(h.run(), /RESULT_AMBIGUOUS/);
    h.inventory(change ? [h.row(change)] : [h.row(), h.row({ keyboardPwdId: 99 })]);
    await assert.rejects(h.run(), /RESULT_AMBIGUOUS/); assert.equal(h.adds.length, 1);
  }
});

test("saved plan cannot cross grants/windows and incomplete inventory cannot authorize a write", async () => {
  const h = harness(); await h.run(); h.input.endDate += 60000;
  await assert.rejects(h.run(), /PLAN_REQUIRES_RECONCILIATION/); assert.equal(h.adds.length, 1);
  const unread = harness(); unread.deps.list = async () => { throw new Error("partial inventory"); };
  await assert.rejects(unread.run(), /SAFE_TO_RETRY:PASSCODE_INVENTORY_UNAVAILABLE/);
  assert.equal(unread.adds.length + unread.timed.length, 0);
});

test("only an explicit later reconciliation rearm allows resubmission after confirmed absence", async () => {
  const h = harness(); const original = h.deps.custom;
  h.deps.custom = async () => { throw new Error("timeout"); };
  await assert.rejects(h.run(), /RESULT_AMBIGUOUS/);
  h.input.rearmedAt = new Date(Date.parse(h.plan().submittedAt!) + 1000).toISOString();
  h.deps.custom = original;
  assert.equal((await h.run()).keyboardPwd, "0125"); assert.equal(h.adds.length, 1);
});

test("provider transport validates association, paginates complete inventory and sends time-bound Custom", async t => {
  const original = globalThis.fetch;
  const old = { base: process.env.TTLOCK_API_BASE, client: process.env.TTLOCK_CLIENT_ID };
  process.env.TTLOCK_API_BASE = "https://synthetic.example.invalid"; process.env.TTLOCK_CLIENT_ID = "synthetic";
  t.after(() => { globalThis.fetch = original;
    if (old.base === undefined) delete process.env.TTLOCK_API_BASE; else process.env.TTLOCK_API_BASE = old.base;
    if (old.client === undefined) delete process.env.TTLOCK_CLIENT_ID; else process.env.TTLOCK_CLIENT_ID = old.client;
  });
  let payload: any = { list: [] };
  let pages = 0;
  const h = harness();
  globalThis.fetch = async (url, init) => {
    const address = new URL(String(url)); assert.equal(address.hostname, "synthetic.example.invalid");
    const form = new URLSearchParams(String(init?.body)); assert.equal(form.get("lockId"), "123");
    if (address.pathname === "/v3/keyboardPwd/add") {
      assert.equal(form.get("keyboardPwd"), "0125"); assert.equal(form.get("keyboardPwdType"), "3");
      assert.equal(form.get("startDate"), String(h.input.startDate)); assert.equal(form.get("endDate"), String(h.input.endDate));
      assert.equal(form.get("addType"), "2"); return Response.json({ keyboardPwdId: 77 });
    }
    if (pages && address.pathname === "/v3/lock/listKeyboardPwd") {
      const pageNo = Number(form.get("pageNo")); assert.equal(pageNo, pages++);
      return Response.json({ list: [h.row({ keyboardPwdId: pageNo })], pages: 2, total: 2 });
    }
    return Response.json(payload);
  };
  assert.equal(await ttlockHasAssociatedGateway(h.input), false);
  payload = { list: [{ gatewayId: 55 }] }; assert.equal(await ttlockHasAssociatedGateway(h.input), true);
  for (const invalid of [{}, { list: [{}] }]) {
    payload = invalid; await assert.rejects(ttlockHasAssociatedGateway(h.input), /ASSOCIATION_INVALID/);
  }
  pages = 1; assert.equal((await ttlockListPasscodes(h.input)).length, 2); assert.equal(pages, 3); pages = 0;
  for (const invalid of [{}, { list: [{}] }, { list: [], total: 1 }]) {
    payload = invalid; await assert.rejects(ttlockListPasscodes(h.input), /INVENTORY_(INVALID|INCOMPLETE)/);
  }
  assert.equal((await ttlockCreatePasscode({ ...h.input, code: "0125", addType: 2 })).keyboardPwdId, 77);
});


test("4117 conflicts advance through provider and local occupancy before using random", async () => {
  const h = harness(); h.input.phone = "+17875554117";
  h.inventory([h.row({ keyboardPwd: "4117" }), h.row({ keyboardPwd: "41170" })]);
  h.input.codeReserved = async code => code === "41171";
  assert.equal((await h.run()).keyboardPwd, "41172");
  assert.equal(h.adds.length, 1); assert.equal(h.plan().source, "PHONE_LAST4_SUFFIX");
  assert.equal(h.adds[0].startDate, h.input.startDate); assert.equal(h.adds[0].endDate, h.input.endDate);
  const exhausted = harness(); exhausted.input.phone = h.input.phone;
  exhausted.input.codeReserved = async code => code.startsWith("4117");
  assert.equal((await exhausted.run()).keyboardPwd, "12345678");
  assert.equal(exhausted.plan().source, "RANDOM");
});

test("uncertain five-digit candidate is recovered without another add or changing its window", async () => {
  const h = harness(); h.input.phone = "+17875554117";
  const occupied = h.row({ keyboardPwd: "4117", keyboardPwdName: "other" });
  h.inventory([occupied]);
  h.deps.custom = async p => { h.adds.push(p); throw new Error("timeout"); };
  await assert.rejects(h.run(), /RESULT_AMBIGUOUS/);
  assert.equal(decryptAccessCode(h.plan().codeEnc), "41170");
  h.input.phone = "+12025559876";
  await assert.rejects(h.run(), /RESULT_AMBIGUOUS/);
  assert.equal(h.adds.length, 1);
  h.inventory([occupied, h.row({ keyboardPwd: "41170" })]);
  assert.equal((await h.run()).keyboardPwd, "41170");
  assert.equal(h.adds.length, 1);
});
