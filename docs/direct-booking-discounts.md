# Direct Booking accommodation discounts

Discounts are a separate subtotal adjustment after nightly pricing. They never change nightly rates or Channex ARI. Default is disabled. Early-booking and length-of-stay levels support enabled state, integer threshold, percentage, booking window, occupied-night window and excluded nights. Date windows are inclusive; every occupied night must qualify. Checkout is not an occupied night. Booking date uses the property's timezone.

Within each type, the highest qualifying threshold wins; ties prefer the larger percentage and then stable rule id. Across types choose the greater discount (default) or apply early booking then length of stay successively. A total percentage cap and a final average-nightly minimum limit the subtotal reduction. The floor never increases an existing rate. Cleaning and amenities retain their amounts. Existing taxes are recomputed on the reduced taxable subtotal.

Configuration uses organization-scoped endpoints, admin-only writes and optimistic version checks. Preview evaluates unsaved settings without changing them. New checkout snapshots store the exact price and discount configuration before Stripe creation. Metadata carries a snapshot id in place of the redundant nightlyRate key, preserving the metadata key budget. Fulfillment checks property, dates, amount and currency, and never reprices a checkout with a snapshot. Legacy checkouts retain their existing behavior. Changed quote totals require the guest to review the refreshed quote before retrying payment.

Pre-arrival reservation changes evaluate current discounts for the proposed stay. In-stay extensions preserve the original discount and price only the additional nights under the existing extension policy. Cancellation refund bases use net accommodation, not gross nightly subtotal.

## Verification

- `npm run test:direct-booking-discounts`: 79 passing tests (including existing modification and extension regressions).
- Prisma schema generation and validation pass. The exact additive migration was executed successfully against disposable local PostgreSQL 16, initialized from the pre-discount schema. No production migration was run.
- Seven native PostgreSQL tests pass: default disabled configuration, unsaved preview without persistence, save/reload and tenant isolation, discounts with dynamic pricing off/on, concurrent version conflicts, and preservation of pricing evidence after configuration changes. The new Direct Booking Discounts PostgreSQL workflow reproduces this with a fresh database.
- Targeted typecheck passes with `npx tsc -p tsconfig.direct-booking-discounts.json --exactOptionalPropertyTypes false`. With the repository's strict optional-property setting, four existing errors occur in auth/session-request-guard.ts and middleware/requireAuth.ts. The full repository typecheck exhausts the local Node heap; it is not a passing check.
- Companion Dashboard build, component typecheck, lint and DOM interaction test pass.

## Release sequence and remaining validation

Apply the migration before deploying backend, then deploy the companion Dashboard. Keep discounts disabled until a staging property passes save/reload, preview/quote/checkout equivalence, paid webhook/replay, cancellation and modification checks against PostgreSQL and a Stripe sandbox. Database persistence and subtotal integration passed. An actual Stripe test Checkout, signed webhook delivery, reservation persistence and fulfillment replay passed on 2026-11-11 in the isolated Railway certification service. No live charge was attempted. Browser visual inspection remains outstanding because local Chromium could not open its process socket; DOM interactions were tested with jsdom.

Prime and coupon discount stacking is NOT wired: the current main branch does not have those discount engines. No nonfunctional controls are shown for them. This change implements the two agreed configurable automatic direct-booking discounts. No production property or OTA configuration was modified.

## Stripe certification evidence — 2026-11-11

- Harness commit: `cd3ea63473fbaa78e8380f7783a986775932a852` on `codex/direct-discounts-stripe-certification`; test-only service guard, test-key guard, synthetic host guard, isolated PostgreSQL schema, no external messaging/access credentials.
- Railway service `4cfd2dfd-3664-4bc6-b5cf-7ca765092f7a`, deployment `7b9d89cc-eefd-42d1-8f0b-f93b4fdc1ab0`, project PinGo Stay-Time Certification / certification.
- Session `cs_test_a0eQivwqpt82g5pVsgMAEVvviDgt7TeP1M9WpaymStlcyDCPujsD61oEM7`; signed Stripe event `evt_1UahRLRqmXnirYx7pWI6Gi7g`.
- Seven nights at $100: original accommodation $700; sequential 10% + 5% discount $101.50; net accommodation $598.50; cleaning $75; amenity $25; test tax $48.90; paid total $747.40.
- Rules were disabled after Checkout creation and before payment. Fulfillment retained the original discount snapshot. The actual production fulfillment function was invoked again with the paid session: reservation count stayed one. Reservation `cmwcj28o4000cmz1b4xssjhno`, test number `PG-2026-000001`.
- Harness logged `CERTIFIED` and `STOPPED failed=false`; its temporary webhook was removed. It shut down before the browser return finished, so the return page displayed Railway's application-not-responding page. This is not a passing visual success-page test.
- Scope excludes real guest/host emails, locks, cleaning notifications and OTA distribution; corresponding fixture audit warnings were expected because those integrations were deliberately absent. The feature is still unmerged and not deployed to production.
