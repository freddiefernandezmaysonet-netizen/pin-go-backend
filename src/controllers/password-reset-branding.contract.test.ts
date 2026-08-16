import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function readPasswordController() {
  return readFile(
    new URL("./password.controller.ts", import.meta.url),
    "utf8"
  );
}

function functionSection(
  source: string,
  startMarker: string,
  endMarker: string
) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.ok(end > start);

  return source.slice(start, end);
}

test("password reset accepts only a clean HTTPS request origin", async () => {
  const source = await readPasswordController();
  const originPolicy = functionSection(
    source,
    "function getSecureOriginHostname",
    "async function getPasswordResetUrl"
  );

  assert.match(originPolicy, /parsed\.protocol !== "https:"/);
  assert.match(originPolicy, /parsed\.username/);
  assert.match(originPolicy, /parsed\.password/);
  assert.match(originPolicy, /parsed\.pathname !== "\/"/);
  assert.match(originPolicy, /parsed\.search/);
  assert.match(originPolicy, /parsed\.hash/);
  assert.match(originPolicy, /return parsed\.hostname/);
});

test("custom reset URL requires a published brand from the same organization", async () => {
  const source = await readPasswordController();
  const resetUrlPolicy = functionSection(
    source,
    "async function getPasswordResetUrl",
    "function generateNumericCode"
  );

  assert.match(
    resetUrlPolicy,
    /resolvePublishedBrandContextByHostname\(hostname\)/
  );
  assert.match(resetUrlPolicy, /context\.kind === "CUSTOM_BRAND"/);
  assert.match(
    resetUrlPolicy,
    /context\.organizationId === params\.organizationId/
  );
  assert.match(
    resetUrlPolicy,
    /https:\/\/\$\{context\.customDomain\}\/reset-password\?token=\$\{encodeURIComponent\(params\.token\)\}/
  );
  assert.doesNotMatch(resetUrlPolicy, /\$\{params\.requestOrigin\}/);
});

test("invalid or mismatched custom origin falls back to Pin&Go configuration", async () => {
  const source = await readPasswordController();
  const resetUrlPolicy = functionSection(
    source,
    "async function getPasswordResetUrl",
    "function generateNumericCode"
  );
  const configuredUrlPolicy = functionSection(
    source,
    "function getConfiguredPasswordResetUrl",
    "function getSecureOriginHostname"
  );

  assert.match(
    resetUrlPolicy,
    /return getConfiguredPasswordResetUrl\(params\.token\)/
  );
  assert.match(configuredUrlPolicy, /process\.env\.PASSWORD_RESET_URL/);
  assert.match(configuredUrlPolicy, /process\.env\.FRONTEND_ORIGIN/);
});

test("verification carries the user organization and request origin into URL selection", async () => {
  const source = await readPasswordController();
  const verificationHandler = functionSection(
    source,
    "export async function verifyForgotPasswordCodeHandler",
    "export async function resetPasswordHandler"
  );

  assert.match(verificationHandler, /organizationId: true/);
  assert.match(
    verificationHandler,
    /createAndSendResetEmail\(user, req\.get\("origin"\)\)/
  );
});
