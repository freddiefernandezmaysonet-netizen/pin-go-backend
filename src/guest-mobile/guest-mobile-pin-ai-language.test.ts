import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual POST handler with session and runtime boundaries stubbed.
const source = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
const endpoint = ast.statements.find(statement => ts.isExpressionStatement(statement) &&
  ts.isCallExpression(statement.expression) && statement.expression.arguments[0]?.getText(ast) ===
  '"/api/guest-mobile/stays/:reservationNumber/pin-ai/messages"') as ts.ExpressionStatement;
const call = endpoint.expression as ts.CallExpression;
const handler = call.arguments.at(-1)!.getText(ast);

test("mobile language contract accepts EN/ES and old clients, rejecting invalid or extra fields", async () => {
  const received: unknown[] = [];
  let sessionReads = 0;
  const run = vm.runInNewContext(ts.transpileModule(`(${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    prisma: {}, process: { env: {} }, console,
    resolveGuestMobileSession: async () => { sessionReads++; return { guestPersonId: "guest" }; },
    resolveGuestMobilePinAIScope: async () => ({ guestToken: "private" }),
    createGuestPinAIRuntimeRunner: () => ({}),
    GuestPinAIGateway: class { async reply(input: unknown) { received.push(JSON.parse(JSON.stringify(input))); return {}; } },
  });
  for (const body of [{ message: "Wi-Fi?", language: "en" }, { message: "Wi-Fi?", language: "es" }, { message: "Wi-Fi?" }]) {
    const res = { setHeader() {}, json() {}, status() { throw Error("Unexpected rejection"); } };
    await run({ body, get: () => "Bearer session", params: { reservationNumber: "PG-TEST" } }, res);
  }
  assert.deepEqual(received, [
    { guestToken: "private", message: "Wi-Fi?", language: "en" },
    { guestToken: "private", message: "Wi-Fi?", language: "es" },
    { guestToken: "private", message: "Wi-Fi?" },
  ]);
  for (const body of [{ message: "Hi", language: "fr" }, { message: "Hi", language: null }, { message: "Hi", language: {} }, { message: "Hi", organizationId: "other" }, { language: "en" }]) {
    let status = 0;
    const res = { setHeader() {}, json() {}, status(value: number) { status = value; return this; } };
    await run({ body, get: () => "Bearer session", params: {} }, res);
    assert.equal(status, 400);
  }
  assert.equal(sessionReads, 3, "invalid payloads never reach session lookup or runtime");
});
