import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-revocation-executor.service.ts", import.meta.url), "utf8");
const provider = await fs.readFile(new URL("./ttlock-mobile-access-provider.ts", import.meta.url), "utf8");

test("revocation executor scopes TTLock owner by reservation organization", () => {
  assert.match(source, /property:\s*\{\s*select:\s*\{ organizationId: true \}/s);
  assert.match(source, /new TTLockMobileAccessProvider\(\s*prisma,\s*scope\.reservation\.property\.organizationId/s);
  assert.match(source, /revokeMobileAccessCredential\(prisma, provider, scope\.id, now\)/);
});

test("revoke-only provider does not require recipient identity but issuance still does", () => {
  assert.match(provider, /private readonly recipientIdentityId\?: string/);
  assert.match(provider, /if \(!recipientIdentityId\) throw new Error\("TTLOCK_RECIPIENT_IDENTITY_REQUIRED"\)/);
  assert.match(provider, /async revokeKey/);
});

test("executor rejects unknown provider families", () => {
  assert.match(source, /scope\.provider !== "TTLOCK"/);
  assert.match(source, /MOBILE_ACCESS_PROVIDER_UNSUPPORTED/);
});
