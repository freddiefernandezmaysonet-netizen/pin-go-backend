# Direct Booking accommodation discounts

Discounts are a separate subtotal adjustment after nightly pricing. They never change nightly rates or Channex ARI. Default is disabled. Early-booking and length-of-stay levels support enabled state, integer threshold, percentage, booking window, occupied-night window and excluded nights. Date windows are inclusive; every occupied night must qualify. Checkout is not an occupied night. Booking date uses the property's timezone.

Within each type, the highest qualifying threshold wins; ties prefer the larger percentage and then stable rule id. Across types choose the greater discount (default) or apply early booking then length of stay successively. A total percentage cap and a final average-nightly minimum limit the subtotal reduction. The floor never increases an existing rate. Cleaning and amenities retain their amounts. Existing taxes are recomputed on the reduced taxable subtotal.

Configuration uses organization-scoped endpoints, admin-only writes and optimistic version checks. Preview evaluates unsaved settings without changing them. New checkout snapshots store the exact price and discount configuration before Stripe creation. Metadata carries a snapshot id in place of the redundant nightlyRate key, preserving the metadata key budget. Fulfillment checks property, dates, amount and currency, and never reprices a checkout with a snapshot. Legacy checkouts retain their existing behavior. Changed quote totals require the guest to review the refreshed quote before retrying payment.

Pre-arrival reservation changes evaluate current discounts for the proposed stay. In-stay extensions preserve the original discount and price only the additional nights under the existing extension policy. Cancellation refund bases use net accommodation, not gross nightly subtotal.

## Verification

- `npm run test:direct-booking-discounts`: 79 passing tests (including existing modification and extension regressions).
- Prisma schema generation and validation pass. Migration is additive, but has NOT been applied to a database in this change.
- Targeted typecheck passes with `npx tsc -p tsconfig.direct-booking-discounts.json --exactOptionalPropertyTypes false`. With the repository's strict optional-property setting, four existing errors occur in auth/session-request-guard.ts and middleware/requireAuth.ts. The full repository typecheck exhausts the local Node heap; it is not a passing check.
- Companion Dashboard build, component typecheck, lint and DOM interaction test pass.

## Release sequence and remaining validation

Apply the migration before deploying backend, then deploy the companion Dashboard. Keep discounts disabled until a staging property passes save/reload, preview/quote/checkout equivalence, paid webhook/replay, cancellation and modification checks against PostgreSQL and a Stripe sandbox. These live integrations have not been exercised here. Browser visual inspection remains outstanding because local Chromium could not open its process socket; DOM interactions were tested with jsdom.

Prime and coupon discount stacking is NOT wired: the current main branch does not have those discount engines. No nonfunctional controls are shown for them. This change implements the two agreed configurable automatic direct-booking discounts. No production property or OTA configuration was modified.
