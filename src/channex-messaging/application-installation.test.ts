import assert from "node:assert/strict";
import test from "node:test";
import { ensureMessagesApplication, type ApplicationRequest } from "./application-installation.js";

const row = (propertyId = "remote-property", id = "installation-1", extra = {}) => ({
  id, type: "application_installation", attributes: {
    property_id: propertyId, application_code: "channex_messages", ...extra,
  },
});

test("existing documented installation is reused without a POST", async () => {
  const calls: unknown[] = [];
  const result = await ensureMessagesApplication("remote-property", async input => {
    calls.push(input); return { data: [row()] };
  });
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.installationId, "installation-1");
  assert.equal(calls.length, 1);
});

test("installation uses the exact documented payload and requires a fresh GET", async () => {
  const calls: Parameters<ApplicationRequest>[0][] = [];
  let installed = false;
  const result = await ensureMessagesApplication("remote-property", async input => {
    calls.push(input);
    if (input.method === "POST") { installed = true; return { data: row() }; }
    return { data: installed ? [row()] : [row("other-property")] };
  });
  assert.equal(result.alreadyInstalled, false);
  assert.deepEqual(calls.map(c => c.method), ["GET", "POST", "GET"]);
  assert.deepEqual(calls[1]?.body, { application_installation: {
    property_id: "remote-property", application_code: "channex_messages",
  } });
  assert.equal(calls[1]?.path, "/api/v1/applications/install");
});

test("a successful POST without installed evidence does not report success", async () => {
  await assert.rejects(ensureMessagesApplication("remote-property", async input =>
    input.method === "POST" ? { data: row() } : { data: [] }), /NOT_VERIFIED/);
});

test("an uncertain POST is not automatically replayed; next invocation reconciles first", async () => {
  let installed = false, posts = 0;
  const request: ApplicationRequest = async input => {
    if (input.method === "POST") {
      posts++; installed = true; throw new Error("OUTCOME_UNKNOWN");
    }
    return { data: installed ? [row()] : [] };
  };
  await assert.rejects(ensureMessagesApplication("remote-property", request), /OUTCOME_UNKNOWN/);
  const result = await ensureMessagesApplication("remote-property", request);
  assert.equal(result.alreadyInstalled, true);
  assert.equal(posts, 1);
});

test("pagination finds installations beyond page one without installing again", async () => {
  const pages: number[] = [];
  const result = await ensureMessagesApplication("remote-property", async input => {
    assert.equal(input.method, "GET");
    pages.push(input.page!);
    return { data: input.page === 1 ? [row("other", "other-id")] : [row()],
      meta: { page: input.page, limit: 1, total: 2 } };
  });
  assert.equal(result.alreadyInstalled, true);
  assert.deepEqual(pages, [1, 2]);
});

for (const [name, response, expected] of [
  ["invalid collection", { data: null }, /RESPONSE_INVALID/],
  ["inactive installation", { data: [row("remote-property", "id", { is_active: false })] }, /INACTIVE/],
  ["duplicate installations", { data: [row(), row("remote-property", "installation-2")] }, /AMBIGUOUS/],
  ["duplicate page identities", { data: [row(), row()] }, /INCONSISTENT/],
  ["invalid active marker", { data: [row("remote-property", "id", { is_active: "true" })] }, /INVALID/],
  ["invalid pagination", { data: [], meta: { page: 2, limit: 100, total: 0 } }, /INCONSISTENT/],
  ["truncated collection", { data: [], meta: { page: 1, limit: 100, total: 5 } }, /INCONSISTENT/],
] as const) {
  test(`${name} blocks installation`, async () => {
    let posts = 0;
    await assert.rejects(ensureMessagesApplication("remote-property", async input => {
      if (input.method === "POST") posts++;
      return response;
    }), expected);
    assert.equal(posts, 0);
  });
}

test("missing property mapping makes no request", async () => {
  let calls = 0;
  await assert.rejects(ensureMessagesApplication(" ", async () => { calls++; return {}; }), /PROPERTY_ID_REQUIRED/);
  assert.equal(calls, 0);
});

test("provider authorization failure does not cause an install attempt", async () => {
  let calls = 0;
  await assert.rejects(ensureMessagesApplication("remote-property", async () => {
    calls++; throw new Error("CHANNEX_MESSAGES_API_HTTP_401");
  }), /401/);
  assert.equal(calls, 1);
});
