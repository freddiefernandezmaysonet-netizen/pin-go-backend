import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const routePath = path.resolve(
  process.cwd(),
  "src/routes/org.ttlock.connect.v2.router.ts"
);

const source = fs.readFileSync(routePath, "utf8");

test("TTLock Connect V2 never logs the request body or credential values", () => {
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*req\.body/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*passwordPlain/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*username/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*access_token/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*refresh_token/);
});

test("TTLock Connect V2 logging is limited to non-secret organization metadata", () => {
  assert.match(source, /TTLOCK CONNECT V2 HIT/);
  assert.match(source, /organizationId:\s*orgId\s*\?\?\s*null/);
  assert.doesNotMatch(source, /console\.log\("BODY:"/);
});
