import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrecheckinDirectBookingUrl } from "./precheckin-direct-booking-link.service.js";

test("return-stay link uses current property eligibility and excludes external reservations", async () => {
  const r = { source: "DIRECT_BOOKING", externalProvider: null, externalId: null, preferredLanguage: "es",
    property: { status: "ACTIVE", isPublicBookable: true, isTestProperty: false, slug: "casa",
      organization: { publicBookingEnabled: true, slug: "host" } } };
  const db = (value: unknown) => ({ reservation: { findUnique: async () => value } }) as any;
  const url = new URL((await resolvePrecheckinDirectBookingUrl(db(r), "r"))!);
  assert.equal(url.origin + url.pathname, "https://pin-ngo.com/book/host/casa");
  assert.equal(url.searchParams.get("utm_campaign"), "precheckin_return_stay");
  assert.equal(url.searchParams.get("lang"), "es");
  assert.ok(await resolvePrecheckinDirectBookingUrl(db({ ...r, source: "MANUAL" }), "r"));
  for (const value of [null, { ...r, source: "AIRBNB" }, { ...r, externalProvider: "CHANNEX" },
    { ...r, externalId: "ota-1" }, ...[{ isPublicBookable: false }, { isTestProperty: true },
    { status: "INACTIVE" }, { slug: null }, { organization: { publicBookingEnabled: false, slug: "host" } }]
      .map(p => ({ ...r, property: { ...r.property, ...p } }))]) {
    assert.equal(await resolvePrecheckinDirectBookingUrl(db(value), "r"), null);
  }
  assert.equal(await resolvePrecheckinDirectBookingUrl({ reservation: { findUnique: async () => { throw Error("offline"); } } } as any, "r"), null);
});

test("precheckin renders bilingual optional CTA after arrival instructions without sending email", async () => {
  process.env.RESEND_API_KEY = "re_offline_test";
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ id: "offline" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { sendGuestPreCheckinEmail } = await import("../lib/mailer.js");
    const base = { to: "offline@example.com", reservationNumber: "TEST", propertyName: "Casa", checkIn: new Date("2026-12-01T20:00:00Z") };
    for (const preferredLanguage of ["es", "en"]) {
      await sendGuestPreCheckinEmail({ ...base, preferredLanguage, directBookingUrl: "https://pin-ngo.com/book/host/casa?lang=es&utm_source=pingo" });
      const html = bodies.at(-1).html;
      const label = preferredLanguage === "es" ? "Reservar mi próxima estadía" : "Book my next stay";
      assert.ok(html.includes(label));
      assert.ok(html.includes("&amp;utm_source=pingo"));
      assert.ok(html.indexOf(label) > html.indexOf(preferredLanguage === "es" ? "Este correo contiene" : "This email contains"));
    }
    for (const directBookingUrl of [undefined, "javascript:alert(1)"]) {
      await sendGuestPreCheckinEmail({ ...base, directBookingUrl });
      assert.ok(!bodies.at(-1).html.includes("Book my next stay"));
    }
  } finally { globalThis.fetch = originalFetch; }
});
