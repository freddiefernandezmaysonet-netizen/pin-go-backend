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
    const managedBrandCookie = configuredAuth.buildAuthCookie(
      "test-token",
      {
        requestOrigin: "https://remansodepaz.pin-ngo.com",
      }
    );
    const deceptiveCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "https://pin-ngo.com.evil.example",
    });
    const insecureCookie = configuredAuth.buildAuthCookie("test-token", {
      requestOrigin: "http://app.pin-ngo.com",
    });
    const alternatePortCookie = configuredAuth.buildAuthCookie(
      "test-token",
      {
        requestOrigin: "https://app.pin-ngo.com:444",
      }
    );
    const customClearCookie = configuredAuth.buildClearAuthCookie({
      requestOrigin: "https://portal.casa-azul.example",
    });

    assert.match(legacyCookie, /Domain=\.pin-ngo\.com/);
    assert.match(legacyCookie, /^pingo_token=/);
    assert.match(standardCookie, /Domain=\.pin-ngo\.com/);
    assert.match(standardCookie, /^pingo_token=/);
    assert.doesNotMatch(customCookie, /Domain=/);
    assert.match(customCookie, /^__Host-pingo_brand_token=/);
    assert.doesNotMatch(managedBrandCookie, /Domain=/);
    assert.match(
      managedBrandCookie,
      /^__Host-pingo_brand_token=/
    );
    assert.doesNotMatch(deceptiveCookie, /Domain=/);
    assert.doesNotMatch(insecureCookie, /Domain=/);
    assert.doesNotMatch(alternatePortCookie, /Domain=/);
    assert.match(alternatePortCookie, /^__Host-pingo_brand_token=/);
    assert.doesNotMatch(customClearCookie, /Domain=/);
    assert.match(customClearCookie, /^__Host-pingo_brand_token=/);
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

test("authentication selects the cookie that belongs to the visible hostname", async () => {
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = "production";
    const configuredAuth = await import(
      new URL(
        `./auth.ts?cookie-selection=${Date.now()}`,
        import.meta.url
      ).href
    );
    const cookies =
      "pingo_token=standard-token; " +
      "__Host-pingo_brand_token=brand-token";

    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          origin: "https://remansodepaz.pin-ngo.com",
          "x-pin-go-brand-hostname": "app.pin-ngo.com",
        },
      }),
      "brand-token"
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          "x-pin-go-brand-hostname": "remansodepaz.pin-ngo.com",
        },
      }),
      "brand-token"
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          origin: "https://app.pin-ngo.com",
        },
      }),
      "standard-token"
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          "x-pin-go-brand-hostname": "app.pin-ngo.com",
        },
      }),
      "standard-token"
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: { cookie: cookies },
      }),
      "brand-token"
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          origin: "https://app.pin-ngo.com,https://evil.example",
        },
      }),
      null
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          cookie: cookies,
          "x-pin-go-brand-hostname": "app.pin-ngo.com,evil.example",
        },
      }),
      null
    );
    assert.equal(
      configuredAuth.extractTokenFromRequest({
        headers: {
          authorization: "Bearer bearer-token",
          cookie: cookies,
          origin: "https://remansodepaz.pin-ngo.com",
        },
      }),
      "bearer-token"
    );
  } finally {
    restoreEnvironmentVariable("NODE_ENV", originalNodeEnv);
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
