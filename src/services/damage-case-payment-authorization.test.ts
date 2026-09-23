import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalDamageTerms, damageAmountMinor, damageAuthorizationText,
  recordDamagePaymentAuthorization, DamagePaymentAuthorizationError,
} from "./damage-case-payment-authorization.service.js";

test("money uses exact decimal cents without rounding", () => {
  for (const [major, minor] of [["0.01", 1], ["19.99", 1999], ["0.29", 29], ["21474836.47", 2147483647]] as const)
    assert.equal(damageAmountMinor(new Prisma.Decimal(major)), minor);
  for (const value of ["0", "-1", "1.001", "21474836.48", "NaN", "Infinity"])
    assert.throws(() => damageAmountMinor(new Prisma.Decimal(value)), DamagePaymentAuthorizationError);
  assert.throws(() => damageAmountMinor(null), DamagePaymentAuthorizationError);
});
test("canonical revision input ignores object key order but preserves evidence order", () => {
  assert.equal(canonicalDamageTerms({ b: { c: 1, a: 2 }, a: [3, 4] }), canonicalDamageTerms({ a: [3, 4], b: { a: 2, c: 1 } }));
  assert.notEqual(canonicalDamageTerms([1, 2]), canonicalDamageTerms([2, 1]));
});
test("both languages disclose exact amount, separate consent, saved method and no charge", () => {
  assert.match(damageAuthorizationText(1099, "en"), /10\.99 USD.*saved payment method.*separate.*does not make a charge/);
  assert.match(damageAuthorizationText(1099, "es"), /10\.99 USD.*método de pago guardado.*adicional.*no realiza ningún cargo/);
});
test("invalid or legacy consent never accesses persistence", async () => {
  const prisma = new Proxy({}, { get() { throw new Error("Unexpected database access"); } }) as PrismaClient;
  const valid = { action: "ACCEPT_AND_AUTHORIZE_PAYMENT", version: "PROPERTY_PROTECTION_PAYMENT_AUTHORIZATION_V1", claimRevision: "a".repeat(64), amountMinor: 100, currency: "usd", language: "en", consent: true };
  for (const body of [null, [], {}, { ...valid, action: "ACCEPTED" }, { ...valid, consent: "true" },
    { ...valid, consent: false }, { ...valid, amountMinor: "100" }, { ...valid, amountMinor: 1.1 },
    { ...valid, currency: "USD" }, { ...valid, language: "fr" }, { ...valid, version: "old" },
    { ...valid, claimRevision: "stale" }, { ...valid, organizationId: "forged" }, { ...valid, authorizedAt: new Date() }]) {
    await assert.rejects(recordDamagePaymentAuthorization({ prisma, guestToken: "synthetic", body }),
      (error: unknown) => error instanceof DamagePaymentAuthorizationError && error.statusCode === 400);
  }
});
test("new boundary has no delivery or financial execution dependencies", () => {
  const source = readFileSync(new URL("./damage-case-payment-authorization.service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["'][^"']*(?:stripe|mailer|notification|queue|worker|mission-control|guest-response)/);
  assert.doesNotMatch(source, /paymentIntents|\.capture\(|\.refunds|\.send\(|damageCase\.update|reservation\.update/);
  const route = readFileSync(new URL("../routes/public-booking.damage-payment-authorization.routes.ts", import.meta.url), "utf8");
  assert.match(route, /Cache-Control.*no-store/);
  const parent = readFileSync(new URL("../routes/public-booking.routes.ts", import.meta.url), "utf8");
  assert.match(parent, /publicBookingRouter\.use\(damagePaymentAuthorizationRouter\(prisma\)\)/);
});
