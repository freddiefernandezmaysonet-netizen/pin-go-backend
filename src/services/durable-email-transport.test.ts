import assert from "node:assert/strict";
import test from "node:test";

test("cancellation retries send the same body and idempotency header through Resend", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.RESEND_API_KEY;
  const oldMode = process.env.NODE_ENV;
  process.env.RESEND_API_KEY = "re_offline_transport_test";
  process.env.NODE_ENV = "production";
  const requests: Array<{ body: any; key: string | null }> = [];
  let fail = true;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    requests.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
    if (fail) { fail = false; return new Response(JSON.stringify({ name: "application_error", message: "offline failure" }), { status: 500 }); }
    return new Response(JSON.stringify({ id: "offline-accepted" }), { status: 200 });
  };
  try {
    const { enqueueOperationalEmail, deliverOperationalEmail } = await import("./durable-operational-email.service.js");
    const now = new Date();
    const checkIn = new Date(+now + 86400000), checkOut = new Date(+now + 172800000);
    for (const purpose of ["guestCancellation", "hostCancellation"] as const) {
      fail = true;
      let row: any;
      const db: any = {
        messageLog: {
          async create({ data }: any) { row = { ...data, retryCount: 0 }; return structuredClone(row); },
          async updateMany({ where, data }: any) {
            if (!Object.entries(where).every(([k,v]) => row[k] === v)) return { count: 0 };
            Object.assign(row, data, data.retryCount ? { retryCount: row.retryCount + 1 } : {});
            return { count: 1 };
          },
        },
        reservation: { async findFirst() { return { status: "CANCELLED", cancelledAt: now,
          checkIn, checkOut, source: "DIRECT_BOOKING", guestEmail: "guest@example.com" }; } },
        dashboardUser: { async findMany() { return [{ email: "host@example.com", role: "ORG_ADMIN" }]; } },
      };
      const m = await enqueueOperationalEmail(db, { purpose, organizationId: "org", propertyId: "property",
        reservationId: "res", eventKey: now.toISOString(), eventAt: now, cancelledAt: now.toISOString(),
        mail: { to: purpose === "hostCancellation" ? "host@example.com" : "guest@example.com",
          guestName: "Guest", reservationNumber: "PG-OFFLINE", propertyName: "Offline property",
          checkIn, checkOut, cancelledAt: now, refundAmount: 25, currency: "USD", totalAmount: 100,
          refundExecution: "PARTIAL_REFUND_EXECUTED" },
      });
      assert.equal(await deliverOperationalEmail(db, m, { now }), "OUTBOX_RETRY");
      assert.equal(await deliverOperationalEmail(db, structuredClone(row), { now: new Date(+now + 61000) }), "SENT");
      const [first, second] = requests.slice(-2);
      assert.ok(first?.key);
      assert.equal(first.key, second?.key);
      assert.deepEqual(first.body, second?.body);
      assert.equal(second?.body.from, "Pin&Go Reservations <reservations@pin-ngo.com>");
      assert.doesNotMatch(second?.body.html ?? "", /Invalid Date/);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
  }
});
