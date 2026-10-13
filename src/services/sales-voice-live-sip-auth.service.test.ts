import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { PrismaClient } from "@prisma/client";
import {
  buildIsolatedSalesLiveSipRouter,
  parseVerifiedLiveSipInvitation,
  recordVerifiedLiveSipInvite,
  unwrapSignedOpenAIWebhook,
  SalesLiveSipError,
} from "./sales-voice-live-sip-auth.service.js";

const url = process.env.SALES_LIVE_SIP_TEST_DATABASE_URL;
assert.ok(url, "Test must use a separate disposable PostgreSQL database");
const target = new URL(url);
assert.equal(target.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, "/pingo_sales_live_sip_test");
assert.equal(process.env.DATABASE_URL, url);
const db = new PrismaClient({ datasources: { db: { url } } });
after(async () => db.$disconnect());

const signingKey = Buffer.from("fixtures-only-32-byte-openai-live-key!!", "utf8");
const secret = "whsec_" + signingKey.toString("base64");
const sessionId = "live_fooBar12345";
const baseEvent = (id = sessionId) => ({
  object: "event",
  id: "evt_live_transport_fixture_123456789",
  type: "live.transport.incoming",
  data: {
    type: "sip",
    session_id: id,
    sip_headers: [
      { name: "From", value: "sip:+17875550123@twilio.test.invalid" },
      { name: "To", value: "sip:proj_test@sip.api.openai.com" },
      { name: "Call-ID", value: "untrusted-sip-token-01" },
    ],
  },
});
const sign = (body: string, timestamp: string, id = "wh_live_fixture") =>
  "v1," + createHmac("sha256", signingKey).update(id + "." + timestamp + "." + body).digest("base64");
const signedRequest = (body: string, seconds = Math.floor(Date.now() / 1000), id = "wh_live_fixture") => ({
  "webhook-id": id,
  "webhook-timestamp": String(seconds),
  "webhook-signature": sign(body, String(seconds), id),
});
function assertCode(fn: () => unknown, code: string) {
  assert.throws(fn, e => e instanceof SalesLiveSipError && e.code === code);
}

test("valid HMAC-SHA256 signed Live event authenticates before parsing", () => {
  const raw = JSON.stringify(baseEvent());
  const verified = unwrapSignedOpenAIWebhook(raw, signedRequest(raw), secret);
  assert.deepEqual(verified, baseEvent());
});

test("modified signed bytes, signature, timestamp or webhook ID fail closed", () => {
  const raw = JSON.stringify(baseEvent());
  const headers = signedRequest(raw);
  assertCode(() => unwrapSignedOpenAIWebhook(raw + " ", headers, secret), "INVALID_WEBHOOK_SIGNATURE");
  assertCode(() => unwrapSignedOpenAIWebhook(raw, { ...headers, "webhook-id": "wh_attacker" }, secret), "INVALID_WEBHOOK_SIGNATURE");
  assertCode(() => unwrapSignedOpenAIWebhook(raw, { ...headers, "webhook-signature": "v1,AAAA" }, secret), "INVALID_WEBHOOK_SIGNATURE");
  assertCode(() => unwrapSignedOpenAIWebhook(raw, { ...headers, "webhook-timestamp": "nonsense" }, secret), "INVALID_SIGNATURE_HEADERS");
});

test("stale and future timestamp replay attempts are rejected", () => {
  const raw = JSON.stringify(baseEvent());
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  assertCode(() => unwrapSignedOpenAIWebhook(raw, signedRequest(raw, seconds - 301), secret, now), "EXPIRED_WEBHOOK_TIMESTAMP");
  assertCode(() => unwrapSignedOpenAIWebhook(raw, signedRequest(raw, seconds + 301), secret, now), "EXPIRED_WEBHOOK_TIMESTAMP");
  assert.deepEqual(unwrapSignedOpenAIWebhook(raw, signedRequest(raw, seconds), secret, now), baseEvent());
});

test("rotated signature candidates permit only a real signature", () => {
  const raw = JSON.stringify(baseEvent());
  const headers = signedRequest(raw);
  const wrong = "v1," + Buffer.alloc(32, 2).toString("base64");
  assert.deepEqual(unwrapSignedOpenAIWebhook(raw, {
    ...headers, "webhook-signature": wrong + " " + headers["webhook-signature"],
  }, secret), baseEvent());
  assertCode(() => unwrapSignedOpenAIWebhook(raw, {
    ...headers, "webhook-signature": Array(9).fill(wrong).join(" "),
  }, secret), "TOO_MANY_SIGNATURES");
});

test("missing/invalid secret and malformed signed JSON fail explicitly", () => {
  const raw = JSON.stringify(baseEvent());
  assertCode(() => unwrapSignedOpenAIWebhook(raw, signedRequest(raw), undefined), "MISSING_SIGNING_SECRET");
  assertCode(() => unwrapSignedOpenAIWebhook(raw, signedRequest(raw), "whsec_invalid^"), "INVALID_SIGNING_SECRET");
  const bad = "{";
  assertCode(() => unwrapSignedOpenAIWebhook(bad, signedRequest(bad), secret), "INVALID_SIGNED_JSON");
});

test("current Live SIP event preserves opaque session ID and treats phones as hints", () => {
  const invitation = parseVerifiedLiveSipInvitation(baseEvent())!;
  assert.equal(invitation.sessionId, sessionId);
  assert.equal(invitation.fromPhoneHint, "+17875550123");
  assert.equal(invitation.toPhoneHint, null);
});

test("legacy Live incoming accepted; Realtime side-event ignored to prevent dual control", () => {
  const legacy: any = baseEvent("live_legacy_123");
  legacy.type = "live.call.incoming";
  delete legacy.data.type;
  assert.equal(parseVerifiedLiveSipInvitation(legacy)?.sessionId, "live_legacy_123");
  assert.equal(parseVerifiedLiveSipInvitation({ ...baseEvent(), type: "realtime.call.incoming" }), null);
  assert.equal(parseVerifiedLiveSipInvitation({ ...baseEvent(), data: { ...baseEvent().data, type: "websocket" } }), null);
});

test("malformed live sessions and caller hints are rejected", () => {
  assertCode(() => parseVerifiedLiveSipInvitation({ ...baseEvent(), data: { type: "sip", session_id: "bad /id", sip_headers: [] } }), "INVALID_SESSION_ID");
  assertCode(() => parseVerifiedLiveSipInvitation({ ...baseEvent(), data: { type: "sip", session_id: sessionId, sip_headers: [{name: "From",value:42}] } }), "INVALID_SIP_HEADERS");
});

test("persistent SIP metadata has correct LIVE provider, no prospect creation", async () => {
  const before = await db.salesProspect.count();
  const invite = parseVerifiedLiveSipInvitation(baseEvent())!;
  const result = await recordVerifiedLiveSipInvite(db, invite);
  assert.equal(result.duplicate, false);
  assert.equal(result.call.provider, "OPENAI_LIVE_SIP");
  assert.equal(result.call.providerCallId, sessionId);
  assert.equal(result.call.prospectId, null);
  assert.equal(await db.salesProspect.count(), before);
});

test("concurrent duplicated Live deliveries yield exactly one database row", async () => {
  const invite = parseVerifiedLiveSipInvitation(baseEvent("live_concurrent_fixture"))!;
  const calls = await Promise.all(Array.from({length: 8}, () => recordVerifiedLiveSipInvite(db, invite)));
  assert.equal(new Set(calls.map(c => c.call.id)).size, 1);
  assert.equal(calls.filter(c => !c.duplicate).length, 1);
  assert.equal(await db.salesVoiceCall.count({ where: { providerCallId: invite.sessionId } }), 1);
});

test("collision on reused session ID with altered caller data fails closed", async () => {
  const invite = parseVerifiedLiveSipInvitation(baseEvent("live_conflict_fixture"))!;
  await recordVerifiedLiveSipInvite(db, invite);
  await assert.rejects(recordVerifiedLiveSipInvite(db, { ...invite, fromPhoneHint: "+12025550144" }),
    e => e instanceof SalesLiveSipError && e.code === "SESSION_ID_COLLISION");
});

async function callRoute(input: {
  enabled?: boolean; secret?: string | undefined;
  body?: object; invalidSignature?: boolean; persistError?: boolean;
}) {
  const app = express();
  let saves = 0;
  app.use(buildIsolatedSalesLiveSipRouter({
    enabled: () => input.enabled ?? false,
    webhookSecret: () => input.secret,
    persist: async () => {
      saves++;
      if (input.persistError) throw Error("Test-only persistence failure");
    },
  }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const body = JSON.stringify(input.body ?? baseEvent());
    const headers = signedRequest(body);
    const response = await fetch("http://127.0.0.1:" + address.port + "/webhooks/openai/sales-live-voice", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
        ...(input.invalidSignature ? {"webhook-signature": "v1,AAAA"} : {}),
      },
      body,
    });
    return { status: response.status, saves };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

test("router is disabled by default with no call side effects", async () => {
  const r = await callRoute({secret});
  assert.deepEqual(r, {status:404,saves:0});
});

test("enabled router with missing or bad signature never stores metadata", async () => {
  const missing = await callRoute({enabled:true});
  assert.deepEqual(missing,{status:401,saves:0});
  const invalid = await callRoute({enabled:true,secret,invalidSignature:true});
  assert.deepEqual(invalid,{status:401,saves:0});
});

test("verified Live event returns only 202 metadata acknowledgement; never accepts call", async () => {
  const r = await callRoute({enabled:true,secret});
  assert.deepEqual(r,{status:202,saves:1});
});

test("Realtime event is ignored even if signed, to avoid dual accept owners", async () => {
  const r = await callRoute({enabled:true,secret,body:{...baseEvent(),type:"realtime.call.incoming"}});
  assert.deepEqual(r,{status:204,saves:0});
});

test("malformed signed SIP event returns 400", async () => {
  const r=await callRoute({enabled:true,secret,body:{...baseEvent(),data:{type:"sip",session_id:"bad id",sip_headers:[]}}});
  assert.deepEqual(r,{status:400,saves:0});
});

test("metadata persistence error returns retryable 503, never falsely acknowledges", async () => {
  const r=await callRoute({enabled:true,secret,persistError:true});
  assert.deepEqual(r,{status:503,saves:1});
});
