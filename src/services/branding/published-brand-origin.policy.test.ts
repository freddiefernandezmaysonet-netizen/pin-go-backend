import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  hostnameFromSecureRequestOrigin,
  isPublishedBrandOriginAllowed,
} from "./published-brand-origin.policy.js";
import type { HostnameBrandResolution } from "./published-brand-context.service.js";

function customContext(hostname: string): HostnameBrandResolution {
  return {
    kind: "CUSTOM_BRAND",
    displayName: "Casa Azul",
    logoUrl: "https://assets.example/logo.png",
    faviconUrl: "https://assets.example/favicon.png",
    primaryColor: "#155EEF",
    onPrimaryColor: "#FFFFFF",
    organizationId: "org-1",
    organizationSlug: "casa-azul",
    revisionId: "revision-1",
    version: 1,
    customDomain: hostname,
    poweredByPinGo: true,
  };
}

test("secure brand origins are normalized without accepting URL ambiguity", () => {
  assert.equal(
    hostnameFromSecureRequestOrigin("https://Portal.Casa-Azul.Example"),
    "portal.casa-azul.example"
  );
  assert.equal(
    hostnameFromSecureRequestOrigin("https://portal.casa-azul.example/"),
    "portal.casa-azul.example"
  );

  for (const origin of [
    "http://portal.casa-azul.example",
    "https://portal.casa-azul.example:443",
    "https://portal.casa-azul.example/login",
    "https://user@portal.casa-azul.example",
    "https://portal.casa-azul.example?next=evil",
    "https://portal.casa-azul.example,https://evil.example",
    "not-an-origin",
    "",
  ]) {
    assert.equal(hostnameFromSecureRequestOrigin(origin), null, origin);
  }
});

test("only the exact active published custom brand context is allowed", async () => {
  const requestedHostnames: string[] = [];
  const resolveBrandContext = async (
    hostname: string
  ): Promise<HostnameBrandResolution> => {
    requestedHostnames.push(hostname);
    return customContext(hostname);
  };

  assert.equal(
    await isPublishedBrandOriginAllowed(
      "https://remansodepaz.pin-ngo.com",
      { resolveBrandContext }
    ),
    true
  );
  assert.deepEqual(requestedHostnames, ["remansodepaz.pin-ngo.com"]);
});

test("unavailable, mismatched and malformed brand origins fail closed", async () => {
  const unavailable = async (
    hostname: string
  ): Promise<HostnameBrandResolution> => ({
    kind: "DOMAIN_UNAVAILABLE",
    hostname,
    reason: "DOMAIN_NOT_ACTIVE",
    poweredByPinGo: true,
  });

  assert.equal(
    await isPublishedBrandOriginAllowed(
      "https://remansodepaz.pin-ngo.com",
      { resolveBrandContext: unavailable }
    ),
    false
  );
  assert.equal(
    await isPublishedBrandOriginAllowed(
      "https://remansodepaz.pin-ngo.com",
      {
        resolveBrandContext: async () =>
          customContext("different.pin-ngo.com"),
      }
    ),
    false
  );

  let resolverCalled = false;
  assert.equal(
    await isPublishedBrandOriginAllowed("http://remansodepaz.pin-ngo.com", {
      resolveBrandContext: async () => {
        resolverCalled = true;
        return customContext("remansodepaz.pin-ngo.com");
      },
    }),
    false
  );
  assert.equal(resolverCalled, false);
});

test("the server delegates non-static CORS origins to the published brand policy", async () => {
  const source = await readFile(
    new URL("../../server.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /import \{ isPublishedBrandOriginAllowed \} from "\.\/services\/branding\/published-brand-origin\.policy\.js";/
  );
  assert.match(source, /void isPublishedBrandOriginAllowed\(origin\)/);
  assert.match(source, /if \(allowed\) return callback\(null, true\)/);
  assert.match(source, /callback\(new Error\("Not allowed by CORS"\)\)/);
});
