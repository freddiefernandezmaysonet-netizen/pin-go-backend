import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { enqueueOperationalEmail, deliverOperationalEmail, EMAIL_REPLAY_WINDOW_MS,
  processOperationalEmailOutbox } from "./durable-operational-email.service.js";

const now = new Date("2026-10-01T19:00:00.123Z");
function fixture(purpose: "cleaning" | "guestCancellation" | "hostCancellation" = "guestCancellation") {
  const rows = new Map<string, any>();
  let failAckWrite = false;
  let lookupCount = 0;
  let afterClaim: (() => void) | undefined;
  const reservation: any = { id: "res", propertyId: "property", organizationId: "org",
    status: purpose === "cleaning" ? "ACTIVE" : "CANCELLED", cancelledAt: now,
    source: "DIRECT_BOOKING", guestEmail: "guest@example.com",
    checkIn: new Date("2026-10-10T19:00:00Z"), checkOut: new Date("2026-10-12T15:00:00Z") };
  const work: any = { id: "work", reservationId: "res", propertyId: "property",
    cancelledAt: null, supersededAt: null, completionConfirmedAt: null };
  const notice: any = { id: "notice", cleaningWorkId: "work", status: "QUEUED", createdAt: now };
  const users: any[] = [{ email: "host@example.com", role: "ORG_ADMIN", isActive: true }];
  const db: any = {
    messageLog: {
      async create({ data }: any) {
        if (rows.has(data.id)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        const row = { retryCount: 0, providerMessageId: null, createdAt: now, ...data };
        rows.set(row.id, structuredClone(row)); return structuredClone(row);
      },
      async findUniqueOrThrow({ where }: any) { return structuredClone(rows.get(where.id)); },
      async findMany({ where }: any) {
        return [...rows.values()].filter(r => where.communicationType.in.includes(r.communicationType) &&
          where.status.in.includes(r.status)).map(r => structuredClone(r));
      },
      async updateMany({ where, data }: any) {
        const row = rows.get(where.id);
        if (!row || !Object.entries(where).every(([k,v]) => row[k] === v)) return { count: 0 };
        if (data.status === "SENT" && failAckWrite) { failAckWrite = false; throw new Error("database unavailable after acceptance"); }
        Object.assign(row, data, data.retryCount ? { retryCount: row.retryCount + data.retryCount.increment } : {});
        if (data.status === "OUTBOX_SENDING") afterClaim?.();
        return { count: 1 };
      },
    },
    reservation: { async findFirst({ where }: any) {
      lookupCount++;
      return reservation.id === where.id && reservation.propertyId === where.propertyId &&
        reservation.organizationId === where.property.organizationId ? structuredClone(reservation) : null;
    } },
    cleaningWork: { async findFirst({ where }: any) {
      return Object.entries(where).every(([k,v]) => work[k] === v) ? structuredClone(work) : null;
    } },
    cleaningHostAttentionNotice: {
      async findUnique({ where }: any) { return where.cleaningWorkId === notice.cleaningWorkId ? structuredClone(notice) : null; },
      async updateMany({ where, data }: any) {
        if (where.cleaningWorkId !== notice.cleaningWorkId || !where.status.in.includes(notice.status)) return { count: 0 };
        Object.assign(notice, data); return { count: 1 };
      },
    },
    dashboardUser: { async findMany({ where }: any) {
      assert.equal(where.organizationId, "org");
      return users.filter(u => u.isActive && (!where.role || u.role === where.role));
    } },
  };
  const input: any = { purpose, organizationId: "org", propertyId: "property", reservationId: "res",
    eventKey: purpose === "cleaning" ? "notice" : now.toISOString(), eventAt: now,
    ...(purpose === "cleaning" ? { cleaningWorkId: "work", idempotencyKey: "cleaning-host-attention-notice" } : { cancelledAt: now.toISOString() }),
    mail: { to: purpose === "cleaning" ? ["host@example.com"] : purpose === "hostCancellation" ? "host@example.com" : "guest@example.com",
      checkIn: reservation.checkIn, checkOut: reservation.checkOut, cancelledAt: now,
      propertyName: "Property", guestName: "Guest", reservationNumber: "PG-TEST", refundAmount: 25 },
  };
  return { db, rows, reservation, work, notice, users, input,
    current: () => structuredClone([...rows.values()][0]),
    failAck: () => { failAckWrite = true; },
    afterClaim: (fn: () => void) => { afterClaim = fn; },
    lookups: () => lookupCount,
  };
}

test("enqueue is durable, unique and freezes payload and provider key across duplicate calls", async () => {
  const f = fixture();
  const first = await enqueueOperationalEmail(f.db, f.input);
  const second = await enqueueOperationalEmail(f.db, { ...f.input, mail: { ...f.input.mail, refundAmount: 999 } });
  assert.equal(f.rows.size, 1); assert.equal(first.body, second.body);
  assert.equal(JSON.parse(second.body).mail.refundAmount, 25);
  assert.equal(first.from, "Pin&Go Reservations <reservations@pin-ngo.com>");
});

test("provider cannot be reached if initial persistence fails", async () => {
  const f = fixture(); let calls = 0;
  f.db.messageLog.create = async () => { throw new Error("db unavailable"); };
  await assert.rejects(async () => {
    const m = await enqueueOperationalEmail(f.db, f.input);
    await deliverOperationalEmail(f.db, m, { now, send: async () => { calls++; return "id"; } });
  }, /db unavailable/);
  assert.equal(calls, 0);
});

for (const kind of ["guestCancellation", "hostCancellation", "cleaning"] as const) {
  test(`${kind}: failed delivery recovers with identical immutable payload and key`, async () => {
    const f = fixture(kind); const m = await enqueueOperationalEmail(f.db, f.input);
    const seen: any[] = [];
    const send = async (e: any) => { seen.push(e); if (seen.length === 1) throw new Error("timeout"); return "provider-id"; };
    assert.equal(await deliverOperationalEmail(f.db, m, { now, send }), "OUTBOX_RETRY");
    assert.equal(await deliverOperationalEmail(f.db, f.current(), { now, send }), "NOT_DUE");
    assert.equal(await deliverOperationalEmail(f.db, f.current(), { now: new Date(+now + 60_001), send }), "SENT");
    assert.equal(seen[0].idempotencyKey, seen[1].idempotencyKey);
    assert.deepEqual(seen[0].mail, seen[1].mail);
    assert.equal(f.current().retryCount, 2);
    assert.equal(f.current().providerMessageId, "provider-id");
    if (kind === "cleaning") { assert.equal(f.notice.status, "SENT"); assert.equal(seen[0].idempotencyKey, "cleaning-host-attention-notice"); }
  });
}

test("concurrent claims allow only one provider call", async () => {
  const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input); let calls = 0;
  const send = async () => { calls++; return "id"; };
  const results = await Promise.all([deliverOperationalEmail(f.db, m, { now, send }), deliverOperationalEmail(f.db, m, { now, send })]);
  assert.equal(calls, 1); assert.ok(results.includes("CLAIM_LOST"));
});

test("provider acceptance followed by failed persistence reuses the same key after lease expiry", async () => {
  const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input); f.failAck();
  const keys: string[] = []; const send = async (e: any) => { keys.push(e.idempotencyKey); return "same-provider-id"; };
  await assert.rejects(deliverOperationalEmail(f.db, m, { now, send }), /database unavailable/);
  assert.equal(f.current().status, "OUTBOX_SENDING");
  assert.equal(await deliverOperationalEmail(f.db, f.current(), { now, send }), "NOT_DUE");
  assert.equal(await deliverOperationalEmail(f.db, f.current(), { now: new Date(+now + 90_001), send }), "SENT");
  assert.equal(keys[0], keys[1]);
});

for (const [name, mutate] of Object.entries({
  "different organization": (f: any) => { f.reservation.organizationId = "other-org"; },
  "different property": (f: any) => { f.reservation.propertyId = "other-property"; },
  "reactivated reservation": (f: any) => { f.reservation.status = "ACTIVE"; },
  "changed cancellation event": (f: any) => { f.reservation.cancelledAt = new Date(+now + 1); },
  "changed guest email": (f: any) => { f.reservation.guestEmail = "other@example.com"; },
  "changed stay dates": (f: any) => { f.reservation.checkOut = now; },
  "no longer Direct Booking": (f: any) => { f.reservation.source = "OTA"; },
})) {
  test(`cancelled notice is obsolete for ${name}`, async () => {
    const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input); mutate(f);
    assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => { assert.fail("must not send"); } }), "OBSOLETE");
  });
}

test("host recipient is revalidated before retry", async () => {
  const f = fixture("hostCancellation"); const m = await enqueueOperationalEmail(f.db, f.input); f.users[0].isActive = false;
  assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => { assert.fail("inactive host"); } }), "OBSOLETE");
});

for (const field of ["completionConfirmedAt", "cancelledAt", "supersededAt"]) {
  test(`cleaning notice stops after ${field}, including changes made after the claim`, async () => {
    const f = fixture("cleaning"); const m = await enqueueOperationalEmail(f.db, f.input);
    f.afterClaim(() => { f.work[field] = now; });
    assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => { assert.fail("work closed"); } }), "OBSOLETE");
    assert.equal(f.lookups(), 2);
  });
}

test("cleaning duplicate enqueue freezes recipient set and cannot create a second event", async () => {
  const f = fixture("cleaning"); const m = await enqueueOperationalEmail(f.db, f.input);
  const duplicate = await enqueueOperationalEmail(f.db, { ...f.input, mail: { ...f.input.mail, to: ["new@example.com"] } });
  assert.equal(m.id, duplicate.id); assert.equal(m.body, duplicate.body);
  f.users[0].email = "new@example.com";
  assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => { assert.fail("recipient removed"); } }), "OBSOLETE");
});

test("max attempts, expired windows and terminal provider errors stop retries", async () => {
  for (const mode of ["attempts", "expired", "permanent"]) {
    const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input);
    if (mode === "attempts") { m.retryCount = 4; f.rows.set(m.id, m); }
    const result = await deliverOperationalEmail(f.db, m, {
      now: mode === "expired" ? new Date(+now + EMAIL_REPLAY_WINDOW_MS) : now,
      send: async () => { if (mode !== "permanent") assert.fail("budget exhausted"); throw { statusCode: 422 }; },
    });
    assert.equal(result, "FAILED_FINAL");
  }
});

test("missing provider acknowledgement is never recorded SENT", async () => {
  const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input);
  assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => "" }), "OUTBOX_RETRY");
});

test("provider concurrency conflict is retryable, payload mismatch is terminal", async () => {
  for (const providerCode of ["concurrent_idempotent_requests", "invalid_idempotent_request"]) {
    const f = fixture(); const m = await enqueueOperationalEmail(f.db, f.input);
    assert.equal(await deliverOperationalEmail(f.db, m, { now,
      send: async () => { throw { statusCode: 409, providerCode }; },
    }), providerCode === "concurrent_idempotent_requests" ? "OUTBOX_RETRY" : "FAILED_FINAL");
  }
});

test("SENT notices reconcile the cleaning projection without sending again", async () => {
  const f = fixture("cleaning"); const m = await enqueueOperationalEmail(f.db, f.input);
  m.status = "SENT"; m.providerMessageId = "accepted";
  assert.equal(await deliverOperationalEmail(f.db, m, { now, send: async () => { assert.fail("already accepted"); } }), "SENT");
  assert.equal(f.notice.providerMessageId, "accepted");
});

test("worker ownership is isolated and retry service has no cancellation/refund execution dependency", async () => {
  const f = fixture();
  f.db.messageLog.findMany = async ({ where }: any) => {
    assert.deepEqual(where.status.in, ["OUTBOX_PENDING", "OUTBOX_RETRY", "OUTBOX_SENDING"]);
    assert.ok(where.communicationType.in.every((v: string) => v.endsWith("_DURABLE_V1")));
    return [];
  };
  await processOperationalEmailOutbox(f.db);
  const service = await readFile(new URL("./durable-operational-email.service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /from ["'].*(?:guest-cancellation|direct-booking-refund|billing\/stripe)/);
  const worker = await readFile(new URL("../workers/message.retry.worker.ts", import.meta.url), "utf8");
  assert.match(worker, /await processOperationalEmailOutbox\(prisma, BATCH_SIZE\)/);
  assert.match(worker, /await processCleaningHostAttentionNotices\(prisma, BATCH_SIZE\)/);
});
