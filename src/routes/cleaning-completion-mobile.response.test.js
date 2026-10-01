import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual route and completion service, not copied render functions.
// Only persistence/provider boundaries and Router registration are replaced.
// A loopback HTTP bridge transports each real handler's res.send() output.
// The VM has no process, network client, provider credentials or database client.
function loadTs(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const errors = (compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, JSON.stringify(errors.map(d => d.messageText)));
  const module = { exports: {} };
  new vm.Script(compiled.outputText, { filename: relativePath }).runInNewContext({
    module, exports: module.exports, Date, Intl,
    console: { log() {}, warn() {}, error() {} },
    require(specifier) {
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency: ${specifier}`);
      return dependencies[specifier];
    },
  }, { timeout: 2000 });
  return module.exports;
}

const completion = loadTs("../services/cleaning-work-completion.prisma.ts");
const timing = loadTs("../services/cleaning-timing-consent.ts");
const completedAt = new Date("2026-10-01T15:44:05.000Z");
const routePath = "/cleaning/confirm/fixture-cleaner-token";

async function fixture(t, overrides = {}) {
  let work = {
    id: "fixture-work", reservationId: "fixture-reservation", propertyId: "fixture-property",
    staffMemberId: "fixture-staff", confirmationId: "fixture-confirmation",
    scheduledStartAt: new Date("2026-10-01T15:10:00.000Z"),
    durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 10, followupGraceMinutes: 15,
    timingConsentVersion: "cleaning_timing_v1", timingConsentAcceptedAt: new Date("2026-09-30T16:00:00Z"),
    startConfirmedAt: new Date("2026-10-01T15:12:00Z"), completionConfirmedAt: null,
    cancelledAt: null, supersededAt: null, ...overrides.work,
  };
  const initial = structuredClone(work);
  const confirmation = { id: work.confirmationId, reservationId: work.reservationId,
    staffMemberId: work.staffMemberId, propertyId: work.propertyId, status: "CONFIRMED" };
  const reservation = { id: work.reservationId, propertyId: work.propertyId,
    status: overrides.reservationStatus ?? "ACTIVE", property: {
      organizationId: "fixture-org", cleaningNfcEnabled: true,
      timezone: overrides.timezone ?? "America/Puerto_Rico",
    } };
  let writes = 0;
  let clock = completedAt;
  const notices = [];
  const resolutions = [];
  const db = {
    async $queryRaw() { return [{ id: reservation.id }]; },
    cleaningConfirmation: { async findUnique({ where }) {
      return where.token === "fixture-cleaner-token" ? { ...confirmation } : null;
    } },
    reservation: { async findUnique() { return structuredClone(reservation); } },
    staffMember: { async findUnique() { return { id: work.staffMemberId, preferredLanguage: overrides.language ?? "en" }; } },
    cleaningWork: {
      async findFirst({ where }) {
        return Object.entries(where).every(([key, value]) => work[key] === value) ? { ...work } : null;
      },
      async update({ where, data }) {
        assert.equal(where.id, work.id);
        assert.deepEqual(Object.keys(data), ["completionConfirmedAt"]);
        writes += 1;
        work = { ...work, ...data };
        return { ...work };
      },
    },
    cleaningHostAttentionNotice: { async updateMany(args) { notices.push(args); return { count: 0 }; } },
    async $transaction(run) { return run(db); },
  };
  const handlers = new Map();
  const router = {
    get(path, handler) { handlers.set(`GET ${path}`, handler); },
    post(path, handler) { handlers.set(`POST ${path}`, handler); },
  };
  const unused = async () => { throw new Error("Unexpected unrelated action in completion test"); };
  loadTs("./cleaning-confirm.routes.ts", {
    "../services/staff-language.service.js": loadTs("../services/staff-language.service.ts"),
    express: { Router: () => router },
    "@prisma/client": { PrismaClient: class { constructor() { return db; } }, ReservationStatus: { CANCELLED: "CANCELLED" } },
    "../services/cleaner-access-autopilot.service": { ensureCleanerNfcAccessForConfirmedCleaning: async () => ({ ok: true }) },
    "../services/reservation-complete-flow-audit.service": { auditReservationCompleteFlowSafe: unused },
    "../services/cleaning-work-snapshot.service.js": { materializeCleaningWorkSnapshot: async (_store, scope) => {
      assert.equal(scope.reservationId, work.reservationId);
      assert.equal(scope.organizationId, "fixture-org");
      return { work: { ...work } };
    } },
    "../services/cleaning-work-snapshot.prisma.js": { createCleaningWorkSnapshotStore: () => ({}) },
    "../services/cleaning-timing-consent.prisma.js": { acceptCleaningTimingConsent: unused },
    "../services/cleaning-timing-consent.js": timing,
    "../services/cleaning-work-start.prisma.js": { confirmCleaningStart: unused },
    "../services/cleaning-work-completion.prisma.js": {
      confirmCleaningCompletion: (client, input) => completion.confirmCleaningCompletion(client, input, clock),
    },
    "../services/cleaning-followup-host-attention.service.js": {
      resolveCleaningHostAttention: async input => { resolutions.push(input); },
    },
  });
  const server = createServer(async (req, res) => {
    const match = /^\/cleaning\/confirm\/([^/]+)(\/complete)?$/.exec(req.url);
    const handler = match && handlers.get(`${req.method} /cleaning/confirm/:token${match[2] ?? ""}`);
    if (!handler) { res.writeHead(404).end(); return; }
    const response = {
      status(code) { res.statusCode = code; return response; },
      send(body) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(body); return response; },
    };
    try { await handler({ params: { token: match[1] } }, response); }
    catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get work() { return work; }, get writes() { return writes; }, initial, notices, resolutions,
    advanceClock() { clock = new Date(completedAt.getTime() + 3600000); },
    async request(method, path = routePath + (method === "POST" ? "/complete" : "")) {
      const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(5000) });
      return { status: response.status, html: await response.text() };
    },
  };
}

function assertCompleted(response, localTime = "11:44 AM AST") {
  assert.equal(response.status, 200);
  assert.match(response.html, /^<!doctype html>/i);
  assert.match(response.html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(response.html, /<section class="cleaner-card">/);
  assert.match(response.html, /<h2>Cleaning completed<\/h2>/);
  assert.ok(response.html.includes(`<p><b>Completed:</b> Oct 1, 2026, ${localTime}</p>`));
  assert.match(response.html, /does not independently certify a physical inspection/);
  assert.doesNotMatch(response.html, /<(?:form|button|input)\b/i);
  assert.doesNotMatch(response.html, /fixture-cleaner-token/);
}

function evidence(name, html) {
  // Test artifact only. Never configured in Railway/Vercel or consumed by application code.
  const directory = process.env.CLEANER_RESPONSE_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name + ".html"), html);
}

test("POST /complete returns the full mobile completion document immediately", async t => {
  const f = await fixture(t);
  const response = await f.request("POST");
  assertCompleted(response);
  assert.equal(f.writes, 1);
  assert.equal(f.work.completionConfirmedAt.toISOString(), completedAt.toISOString());
  const { completionConfirmedAt: _completion, ...remaining } = f.work;
  const { completionConfirmedAt: _initialCompletion, ...initial } = f.initial;
  assert.deepEqual(remaining, initial);
  assert.equal(f.notices[0].where.cleaningWorkId, "fixture-work");
  assert.equal(f.notices[0].data.status, "OBSOLETE");
  assert.equal(f.resolutions[0].occurredAt.toISOString(), completedAt.toISOString());
  evidence("post-complete", response.html);
});

test("GET after completion returns the same document without another completion write", async t => {
  const f = await fixture(t);
  const post = await f.request("POST");
  const get = await f.request("GET");
  assertCompleted(get);
  assert.equal(get.html, post.html);
  assert.equal(f.writes, 1);
  evidence("get-completed", get.html);
});

test("repeated POST preserves the original completion timestamp and identical document", async t => {
  const f = await fixture(t);
  const first = await f.request("POST");
  f.advanceClock();
  const repeated = await f.request("POST");
  assertCompleted(repeated);
  assert.equal(repeated.html, first.html);
  assert.equal(f.work.completionConfirmedAt.toISOString(), completedAt.toISOString());
  assert.equal(f.writes, 1);
  evidence("post-complete-repeated", repeated.html);
});

test("GET of an existing completed legacy snapshot remains read-only and legible", async t => {
  const f = await fixture(t, { work: { completionConfirmedAt: completedAt, startConfirmationGraceMinutes: 30 } });
  assertCompleted(await f.request("GET"));
  assert.equal(f.writes, 0);
  assert.deepEqual(f.work, f.initial);
});

test("completion uses the property timezone rather than hardcoded Puerto Rico time", async t => {
  const f = await fixture(t, { timezone: "America/Los_Angeles" });
  assertCompleted(await f.request("POST"), "8:44 AM PDT");
});

test("unstarted GET retains only its next start action", async t => {
  const f = await fixture(t, { work: { startConfirmedAt: null } });
  const response = await f.request("GET");
  assert.equal(response.status, 200);
  assert.match(response.html, /<h2>Cleaning timing confirmed<\/h2>/);
  assert.match(response.html, />I started cleaning<\/button>/);
  assert.doesNotMatch(response.html, />I finished cleaning<\/button>/);
  assert.equal(f.writes, 0);
});

test("in-progress GET retains only the finish action", async t => {
  const f = await fixture(t);
  const response = await f.request("GET");
  assert.equal(response.status, 200);
  assert.match(response.html, /<h2>Cleaning in progress<\/h2>/);
  assert.match(response.html, />I finished cleaning<\/button>/);
  assert.doesNotMatch(response.html, />I started cleaning<\/button>/);
  assert.equal(f.writes, 0);
});

for (const [name, overrides, status] of [
  ["missing start", { work: { startConfirmedAt: null } }, 409],
  ["missing consent", { work: { timingConsentAcceptedAt: null } }, 409],
  ["cancelled reservation", { reservationStatus: "CANCELLED" }, 410],
  ["superseded work", { work: { supersededAt: new Date("2026-10-01T15:30:00Z") } }, 409],
]) {
  test(`${name} does not produce a success screen or completion write`, async t => {
    const f = await fixture(t, overrides);
    const response = await f.request("POST");
    assert.equal(response.status, status);
    assert.doesNotMatch(response.html, /<h2>Cleaning completed<\/h2>/);
    assert.equal(f.writes, 0);
    assert.equal(f.notices.length, 0);
    assert.equal(f.resolutions.length, 0);
  });
}

test("an invalid token cannot complete any work", async t => {
  const f = await fixture(t);
  const response = await f.request("POST", "/cleaning/confirm/invalid-token/complete");
  assert.equal(response.status, 404);
  assert.equal(f.writes, 0);
});

for (const language of ["en", "es"]) {
  for (const timezone of ["America/Puerto_Rico", "America/Los_Angeles"]) {
    test(`completion renders ${language} in ${timezone} and preserves idempotency`, async t => {
      const f = await fixture(t, { language, timezone });
      const response = await f.request("POST");
      assert.equal(response.status, 200);
      assert.ok(response.html.includes(`<html lang="${language}">`));
      assert.match(response.html, language === "es" ? /<h2>Limpieza completada<\/h2>/ : /<h2>Cleaning completed<\/h2>/);
      assert.doesNotMatch(response.html, language === "es" ? /<h2>Cleaning completed/ : /<h2>Limpieza completada/);
      const expected = new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", {
        timeZone: timezone, year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
      }).format(completedAt);
      assert.ok(response.html.includes(expected));
      assert.equal((await f.request("POST")).html, response.html);
      assert.equal(f.writes, 1);
    });
  }
}
