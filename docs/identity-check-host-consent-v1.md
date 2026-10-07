# Identity Check: host billing consent per property

When a host saves Secure Guest Access with Identity Check enabled, the dashboard displays the current server-side USD tariff and requires explicit acceptance unless valid acceptance already exists for the property. The existing Direct Booking tariff is read from `DIRECT_BOOKING_PROTECTION_FEE_AMOUNT` (default 2.50). The collection method remains the application fee deducted from the reservation payment before the host Connect payout. This does not introduce Account Debits, OTA identity requirements or additional charges.

The acceptance snapshots the terms version, amount in cents, server timestamp and authenticated admin actor into an immutable PropertyGuestAgreement version. Agreement edits preserve valid acceptance. A tariff change changes the terms version and requires renewed acceptance on the next enabled settings save. Historical agreements and reservation snapshots are retained; old enablement does not count as acceptance.

The mutation checks active database admin role and tenant, validates trusted origin for cookie authentication, locks the tenant-scoped property row and verifies the expected agreement version before any write. Disable needs no acceptance. An uncertain UI save requires a fresh read before retry.

Validation: 5 consent-policy tests, 6 actual HTTP tests using an injected transaction fixture, and 6 existing Connect fee tests passed. The HTTP fixture validates routing, permissions and commands; it is not a native PostgreSQL concurrency certification. Full changed-route TypeScript and Prisma generation are required before publication. Paired dashboard has 5 React interaction tests, TypeScript, ESLint and Vite build checks.

Release: local implementation only. Migration `20261006231500_identity_check_host_consent` must be applied before deploying either side; no migration has been applied remotely. Deploy backend contract first, then the dashboard. No production data, configuration, billing policy or existing reservation was changed by this work.
