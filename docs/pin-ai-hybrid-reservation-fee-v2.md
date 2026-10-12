# Pin AI reservation fee v2

New bookings at an enabled, nonexempt property with explicit v2 consent incur USD 1.00 at intake. Direct Booking adds 100 cents to the existing application fee and deducts it from host proceeds; the guest total is unchanged. OTA and manual reservations create a pending item on the organization's Pin&Go membership subscription. No balance debit or liability change is used.

One ledger row per reservation is enforced by the existing primary key. Intake changes, cancellations, replayed webhooks and historical reservations do not create another obligation. Direct Checkout stores immutable consent evidence on both the Checkout Session and PaymentIntent. Its webhook can recover a missing ledger on replay. The worker verifies the connected account, payment, application fee and membership ownership before marking paid.

Cancellation removes pending/draft membership items. A finalized invoice receives a credit note against the exact Pin AI line: outstanding debt is reduced and any paid portion is credited to the host's customer balance for the next invoice. Direct cancellations return Pin AI in full and return the other application-fee components proportionally to the guest payment refund. Guest refunds suppress Stripe's automatic application-fee refund for v2 to avoid mixing policies. The worker revisits direct cancellations if a guest refund occurs later. Exempt properties have no new charge and retain legacy acceptance for guest assistance.

Persisted leases fence overlapping workers. Every external mutation uses a pinned key; uncertain operations retain their start timestamp and immutable reversal payload. After 23 hours, retries use GET reconciliation only. Missing or multiple operations require review rather than creating another charge. Cancellation cleanup continues when the new-collection rollout is disabled. Changes to cancellation or reservation data wake settlement; otherwise polling is bounded to 20 rows per minute.

## Deployment order

1. Apply `prisma/migrations/20261012000000_pin_ai_hybrid_fee/migration.sql` through the existing controlled Prisma migration process, before deploying the generated client. The seven new nullable columns preserve existing ledger rows. Do not backfill or reinterpret legacy fees.
2. Deploy backend and reservation worker, then dashboard. New collection remains off by default.
3. In Stripe test mode certify a nonexempt Direct Booking checkout and full/partial/zero guest refund; verify the connected account receives the complete Pin AI refund. Certify a membership item through draft, finalized open and paid invoice states; confirm removal or customer credit. Test a lost response and cancellation replay.
4. Enable `PIN_AI_HYBRID_BILLING_ENABLED=true` for backend and reservation worker. Set `PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS` to the canary organization's ID, or use the existing `PIN_AI_ALL_ORGANIZATIONS_ENABLED=true` after certification. Keep property activation and reservation-fee recording switches enabled.
5. Nonexempt properties must explicitly accept `pin-ai-hybrid-usd-1-reservation-v2`. No account/controller configuration changes are required. A missing/inactive membership remains pending; it is never charged to a guest or standalone Connect balance.

Guest chat remains available from 24 hours before check-in to 24 hours after checkout. Billing does not depend on a chat interaction or cleaner activation.

## Validation

`tsc -p tsconfig.pin-ai-hybrid-billing.json` checks the billing services. Provider tests verify account context, invoice binding, partial commissions and precise reversal amounts. PostgreSQL tests in the native certification workflow cover intake, unique accrual, concurrent settlement, transaction rollback, uncertain responses, expired idempotency retention and cancellation. No live Stripe payments are created by these tests. A Stripe test-mode certification is required before paid production rollout.

References: https://docs.stripe.com/connect/direct-charges ; https://docs.stripe.com/api/invoiceitems/create ; https://docs.stripe.com/api/credit_notes/create .
