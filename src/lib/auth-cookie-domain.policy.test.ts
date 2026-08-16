import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

function restoreEnvironmentVariable(
  name: "NODE_ENV" | "COOKIE_DOMAIN",
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test("authentication cookies isolate custom domains without changing Pin&Go sessions", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  try {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_DOMAIN = ".pin-ngo.com";

    const configuredAuth = await import(
      new URL(
        `./auth.ts?configured-cookie-domain=${Date.now()}`,
        import.meta.url
      ).href
    );

    const legacyCookie = configuredAuth.buildAuthCookie("test-token");
    const standardCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "https://app.pin-ngo.com",
    });
    const customCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "https://portal.casa-azul.example",
    });
    const deceptiveCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "https://pin-ngo.com.evil.example",
    });
    const insecureCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "http://app.pin-ngo.com",
    });
    const customClearCookie = configuredAuth.buildClearAuthCookie({
      requestOrigin: "https://portal.casa-azul.example",
    });

    assert.match(legacyCookie, /Domain=\.pin-ngo\.com/);
    assert.match(standardCookie, /Domain=\.pin-ngo\.com/);
    assert.doesNotMatch(customCookie, /Domain=/);
    assert.doesNotMatch(deceptiveCookie, /Domain=/);
    assert.doesNotMatch(insecureCookie, /Domain=/);
    assert.doesNotMatch(customClearCookie, /Domain=/);
    assert.match(customCookie, /HttpOnly/);
    assert.match(customCookie, /SameSite=None/);
    assert.match(customCookie, /Secure/);
    assert.match(customClearCookie, /Max-Age=0/);

    delete process.env.COOKIE_DOMAIN;

    const hostOnlyAuth = await import(
      new URL(
        `./auth.ts?unset-cookie-domain=${Date.now()}`,
        import.meta.url
      ).href
    );
    const hostOnlyCookie = hostOnlyAuth.buildAuthCookie("test-token", {
      requestOrigin: "https://app.pin-ngo.com",
    });

    assert.doesNotMatch(hostOnlyCookie, /Domain=/);
    assert.match(hostOnlyCookie, /HttpOnly/);
    assert.match(hostOnlyCookie, /SameSite=None/);
    assert.match(hostOnlyCookie, /Secure/);
  } finally {
    restoreEnvironmentVariable("NODE_ENV", originalNodeEnv);
    restoreEnvironmentVariable("COOKIE_DOMAIN", originalCookieDomain);
  }
});

test("all authentication routes pass the request origin to cookie builders", async () => {
  const source = await readFile(
    new URL("../routes/auth.routes.ts", import.meta.url),
    "utf8"
  );
  const authCookieCalls =
    source.match(/buildAuthCookie\(token,\s*\{/g) ?? [];
  const clearCookieCalls =
    source.match(/buildClearAuthCookie\(\{\s*requestOrigin:/g) ?? [];
  const requestOriginAssignments =
    source.match(/requestOrigin:\s*req\.get\("origin"\)/g) ?? [];

  assert.equal(authCookieCalls.length, 2);
  assert.equal(clearCookieCalls.length, 4);
  assert.equal(requestOriginAssignments.length, 6);
  assert.doesNotMatch(source, /buildAuthCookie\(token\)\s*\)/);
  assert.doesNotMatch(source, /buildClearAuthCookie\(\)\s*\)/);
});
