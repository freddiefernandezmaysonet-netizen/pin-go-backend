import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isOtaGuestExternalDeliveryBlocked } from "../services/ota-guest-external-messaging.policy.ts";

// Execute the real route handler, not a duplicate implementation. Only its
// infrastructure boundaries are replaced. Unexpected imports fail closed:
// these tests cannot contact Prisma, Twilio, Channex, Resend or the network.
const source = readFileSync(new URL("./dashboard.messages.routes.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "dashboard.messages.routes.ts",
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);

const configured = "AIRBNB,BOOKING_COM";
function fixture(options = {}) {
  const env = { OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: options.config ?? configured };
  const msg = {
    id: "message-test", organizationId: "org-test", propertyId: "property-test",
    reservationId: "reservation-test", communicationType: "GUEST_ACCESS_PASSCODE",
    channel: "sms", status: "FAILED", to: "+17875550100",
    body: "Synthetic operational message", error: "original failure", retryCount: 2,
    providerMessageId: "original-synthetic-sid", accessGrant: null,
    ...options.message,
  };
  const reservation = options.reservation === null ? null : {
    id: "reservation-test", source: options.source ?? "BookingCom",
    externalProvider: options.externalProvider ?? "CHANNEX",
    externalId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-test", ...options.reservation,
  };
  const queries = [], writes = [], sends = [];
  let handler;
  const db = {
    messageLog: {
      findFirst: async args => {
        const row = structuredClone(msg);
        // Respect the actual Prisma projection for historical rows whose only
        // reservation identity is the access-grant relation.
        if (row.accessGrant && !args.include.accessGrant.select.reservation.select.id) {
          delete row.accessGrant.reservation.id;
        }
        return row;
      },
      update: async args => { writes.push(args); return args.data; },
    },
    reservation: {
      findFirst: async args => {
        queries.push(args);
        return reservation && args.where.id === reservation.id &&
          args.where.property.organizationId === reservation.organizationId ? reservation : null;
      },
    },
  };
  const imports = {
    express: { Router: () => ({
      get: () => {},
      post: (path, ...handlers) => {
        assert.equal(path, "/messages/:id/retry");
        handler = handlers.at(-1);
      },
    }) },
    "@prisma/client": { PrismaClient: function () { return db; } },
    "../middleware/requireOrg": { requireOrg: () => () => {} },
    "../services/guest-access-sms-retry-body.service.js": {
      buildGuestAccessSmsRetryBody: async () => "Synthetic current body",
    },
    "../channex-messaging/airbnb-access.service.js": {
      retireAirbnbLegacyRetry: async () => options.pilot ?? false,
    },
    "../services/ota-guest-external-messaging.policy.js": {
      isOtaGuestExternalDeliveryBlocked: (row, channel) =>
        isOtaGuestExternalDeliveryBlocked(row, channel, env),
    },
    "../integrations/twilio/twilio.client": {
      sendSms: async (to, body) => {
        sends.push({ to, body });
        return { sid: "synthetic-accepted-sid" };
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, process: { env },
    console: { error: () => {} },
    require: name => {
      assert.ok(Object.hasOwn(imports, name), "Unexpected dependency: " + name);
      return imports[name];
    },
  }, { filename: "dashboard.messages.routes.cjs" });
  assert.equal(typeof handler, "function");
  const response = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const run = () => handler({ orgId: "org-test", params: { id: msg.id }, body: { source: "VRBO" } }, response);
  return { run, response, sends, writes, queries, msg };
}

for (const source of ["Airbnb", "BookingCom", "Booking.com"]) {
  for (const communicationType of ["PRECHECKIN", "GUEST_ACCESS_PASSCODE", "CHECKOUT"]) {
    test(`${source} ${communicationType}: manual retry never reaches Twilio`, async () => {
      const f = fixture({ source, message: { communicationType } });
      await f.run();
      assert.equal(f.response.statusCode, 409);
      assert.equal(f.response.body.error, "OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED");
      assert.equal(f.sends.length, 0);
      assert.equal(f.writes.length, 0, "do not falsify the original SID/error/retry count");
      assert.equal(f.queries[0].where.property.organizationId, "org-test");
    });
  }
}
for (const source of ["VRBO", "Expedia"]) {
  test(`${source}: existing permitted manual SMS retry remains available`, async () => {
    const f = fixture({ source }); await f.run();
    assert.equal(f.response.statusCode, 200);
    assert.equal(f.sends.length, 1);
    assert.equal(f.writes.length, 1);
  });
}
test("Direct Booking retains its permitted retry", async () => {
  const f = fixture({ source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT" });
  await f.run(); assert.equal(f.sends.length, 1); assert.equal(f.response.statusCode, 200);
});
test("unset variable preserves the existing route without a new reservation query", async () => {
  const f = fixture({ config: "" }); await f.run();
  assert.equal(f.sends.length, 1); assert.equal(f.queries.length, 0);
});
test("staff cleaning messages on the same OTA reservation are not blocked", async () => {
  const f = fixture({ message: { communicationType: "CLEANING_START" } }); await f.run();
  assert.equal(f.sends.length, 1); assert.equal(f.queries.length, 0);
});
test("legacy access-grant relation supplies a current, tenant-scoped reservation ID", async () => {
  const f = fixture({ message: { reservationId: null,
    accessGrant: { reservation: { id: "reservation-test", property: { organizationId: "org-test" } } },
  } }); await f.run();
  assert.equal(f.response.statusCode, 409); assert.equal(f.sends.length, 0);
  assert.equal(f.queries[0]?.where.id, "reservation-test");
});
test("an unresolved guest reservation fails closed without a send or history rewrite", async () => {
  const f = fixture({ reservation: null }); await f.run();
  assert.equal(f.response.statusCode, 409); assert.equal(f.sends.length, 0); assert.equal(f.writes.length, 0);
});
test("a reservation belonging to another tenant cannot authorize the retry", async () => {
  const f = fixture({ source: "VRBO", reservation: { organizationId: "other-org" } }); await f.run();
  assert.equal(f.response.statusCode, 409); assert.equal(f.sends.length, 0);
});
test("conflicting direct and access-grant reservation IDs never authorize the retry", async () => {
  const f = fixture({ source: "VRBO", message: {
    accessGrant: { reservation: { id: "other-reservation", property: { organizationId: "org-test" } } },
  } }); await f.run();
  assert.equal(f.response.statusCode, 409); assert.equal(f.sends.length, 0);
});
test("Channex messages cannot be converted into SMS through manual retry", async () => {
  const f = fixture({ message: { channel: "channex" } }); await f.run();
  assert.equal(f.response.statusCode, 400); assert.equal(f.sends.length, 0); assert.equal(f.writes.length, 0);
});
test("existing pilot-owned messages retain the legacy rejection", async () => {
  const f = fixture({ pilot: true }); await f.run();
  assert.equal(f.response.statusCode, 409); assert.equal(f.response.body.error, "AIRBNB_CHANNEL_OWNS_DELIVERY");
  assert.equal(f.sends.length, 0);
});
