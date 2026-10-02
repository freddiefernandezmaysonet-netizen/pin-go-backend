import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildPublicStaysSitemap } from "./public-stays-sitemap.service.js";
const standard = async () => ({ kind: "PIN_GO_STANDARD", customDomain: null });
const row = (id: string, slug = id, org = "host") => ({ id, slug, organization: { id: org, slug: org } });
function mockDb(findMany: (query: any) => Promise<any[]>) {
  return { property: { findMany } } as unknown as Pick<PrismaClient, "property">;
}

test("only queries real active published properties of published organizations", async () => {
  const xml = await buildPublicStaysSitemap(mockDb(async q => {
    assert.deepEqual(q.where, { status: "ACTIVE", isPublicBookable: true, isTestProperty: false, slug: { not: null }, organization: { publicBookingEnabled: true, slug: { not: null } } });
    return [row("serena", "palmasdelmar", "serena-studio"), row("new-real-property")];
  }), standard);
  assert.match(xml, /serena-studio\/palmasdelmar/);
  assert.match(xml, /host\/new-real-property/);
});

test("paginates automatically, encodes paths and avoids custom-domain duplicates", async () => {
  let calls = 0;
  const xml = await buildPublicStaysSitemap(mockDb(async q => {
    if (++calls === 1) return Array.from({ length: 500 }, (_, i) => row(String(i)));
    assert.deepEqual(q.cursor, { id: "499" }); assert.equal(q.skip, 1);
    return [row("501", "villa & mar"), row("502", "suite", "custom"), row("503", "../private")];
  }), async id => id === "custom" ? { kind: "CUSTOM_BRAND", customDomain: "stay.example.com" } : standard());
  assert.equal(calls, 2);
  assert.match(xml, /villa%20%26%20mar/);
  assert.doesNotMatch(xml, /custom|private/);
  assert.equal((xml.match(/<loc>/g) ?? []).length, 501);
});

test("failures propagate instead of publishing an empty successful sitemap", async () => {
  await assert.rejects(buildPublicStaysSitemap(mockDb(async () => { throw new Error("database down"); }), standard), /database down/);
  await assert.rejects(buildPublicStaysSitemap(mockDb(async () => [row("1")]), async () => { throw new Error("brand down"); }), /brand down/);
});
