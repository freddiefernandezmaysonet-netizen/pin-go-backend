# Pin AI hybrid billing sandbox certification — 2026-10-12

Railway project `PinGo Stay-Time Certification`, environment `certification`, already contains the Stripe sandbox credential. It was reused through the existing one-shot function; no credential was extracted or exposed, and the production project and stay-time API were not changed.

The production membership provider passed four real Stripe cases using SDK 14.25.0/API 2023-10-16: pending item deletion, draft item deletion, credit against an open invoice, and customer credit after a USD 1.00 test-card payment. Each item and reversal replay reused its original ID. All four cancellations ended with net Pin AI USD 0.00. A subsequent GET verified the paid customer's credit balance was -100 cents and all four synthetic subscriptions were canceled. Earlier unused prices and zero-value draft invoices were closed. The function was restored to its prior expired read-only source.

The sandbox exposed a real compatibility defect: Stripe rejects `credit_amount=0`. The provider now omits that field for credits against unpaid invoices, while sending the paid portion for partially/fully paid invoices. This correction and its regression assertion are in backend PR #407; the candidate is `3627eeac8372edf95fb69f88bd0c755217d0c5a9` and all 58 checks passed.

Actual execution receipts are in `src/pin-ai/fixtures/hybrid-membership-stripe-sandbox-20261012.json`. Certification deployment: `0722541b-f30d-46c1-aad1-f139869020de`. Cleanup/read-back deployment: `f3b73c03-f56a-42b1-bdfa-063d193bb91c`. These are real Stripe provider tests; PostgreSQL concurrency/persistence was certified separately. Public HTTP, signed webhook delivery and the live worker were not exercised by this script.

## Complete financial provider certification

After the user completed Stripe-hosted onboarding, GET verification confirmed charges enabled with no requirements outstanding. The synthetic account remains `acct_1UPbUgRqmXnirYx7`, with losses owned by Stripe, fees paid by the connected account and no Stripe Dashboard. No existing host account was modified.

Run `qa-pin-ai-hybrid-1c0d6f8b-951a-4ad0-947f-1552146284b5`, deployment `463feb0d-63bb-481c-b582-9cba5f634167`, passed all seven real Stripe cases. Direct Booking guest payments stayed at 10000 cents and the total application fee was 600 cents (100 Pin AI plus 500 other commission). Cancellation with guest refunds of 0/5000/10000 cents returned application fees of 100/350/600 cents respectively: full Pin AI fee return plus proportional other commission. Each payment/refund replay returned its original ID; read-only reversal reconciliation matched. The pending/draft/open/paid membership cases also passed again, with net Pin AI charge zero.

A separate GET-only cleanup run confirmed all three guest payments fully refunded, all three total application fees fully returned, all four subscriptions canceled, their price/product inactive, and the paid customer's credit balance -100 cents. Evidence is in `src/pin-ai/fixtures/hybrid-complete-stripe-sandbox-20261012.json`, including cleanup deployment ID and the actual resource IDs. The one-shot Railway function was subsequently left idle with no Stripe requests.

These results certify the production Stripe provider against the real sandbox configuration. They do not certify public HTTP, signed webhooks, reservation persistence or the live worker as one combined end-to-end flow. That remains a release validation requirement. Production billing remains disabled and the implementation PRs remain unmerged.

The earlier blocked attempts are retained in `src/pin-ai/fixtures/hybrid-direct-stripe-sandbox-20261012.json` as historical evidence. Their onboarding blocker has now been resolved. No identity, bank details or short-lived onboarding link is retained in the certification receipts.

Membership-only tests are independently implemented in `src/scripts/certify-pin-ai-membership-sandbox.ts`; that runner has no Connect identity, bank or TOS mutation. Paid production collection remains disabled, and PRs #407 and dashboard #217 remain unmerged.

References: https://docs.stripe.com/connect/testing ; https://docs.stripe.com/api/credit_notes/create ; https://docs.stripe.com/api/invoiceitems/create .

## Public Checkout metadata boundary

The integrated audit found a second release blocker: public Checkout already used Stripe's 50 Session metadata keys, and adding hybrid consent produced 54 after the existing billing normalization. The public route now omits four legacy display fields only for hybrid checkout (`cancellationPolicyName`, `cancellationPolicyType`, `refundPercentBeforeDeadline`, `refundPercentAfterDeadline`). Their complete values remain in the existing serialized cancellation snapshot; guest and host acceptance evidence is retained. Legacy/exempt checkout metadata remains unchanged.

A regression test evaluates the actual route metadata expression for both consent modes and validates the wrapper's normalization, the 50-key budget and the complete cancellation snapshot. All 12 provider/boundary tests and 25 targeted Direct Booking/financial replay checks passed; both billing and Direct Booking TypeScript configurations compiled. All 58 PR #407 checks passed at candidate `3627eeac8372edf95fb69f88bd0c755217d0c5a9`.

Real Stripe accepted both Checkout Sessions against the synthetic account with 50 keys and guest total 10000 cents. The consent evidence was preserved and both unpaid Sessions were expired immediately. Receipts are in `src/pin-ai/fixtures/hybrid-checkout-metadata-stripe-sandbox-20261012.json`. This certification evaluates route metadata but does not itself exercise the public HTTP route.

## Integrated HTTP, signature, PostgreSQL and fee cycle

Workflow run `38253217938`, job `114824529483`, passed compilation and the complete internal flow on disposable PostgreSQL 16: public HTTP checkout creates unchanged guest total and hybrid consent; a malformed signature is rejected without a reservation; a valid signed `checkout.session.completed` creates one ACTIVE/PAID reservation and one 100-cent fee; repeated delivery is acknowledged as a duplicate; the production hybrid worker cycle verifies direct payment evidence and marks the fee PAID; cancellation makes one 100-cent fee reversal; another cycle does not duplicate it. Resource IDs and counts are recorded in `src/pin-ai/fixtures/hybrid-http-postgres-worker-20261012.json`.

This run uses real Express HTTP, Stripe signature verification, PostgreSQL, ingest, event ledger, and the production worker billing cycle. Stripe transport is simulated and no external messaging/access credentials are present. The separate real Stripe receipts validate the transport adapter and Checkout metadata, but this is not a certification of Stripe's actual webhook delivery to Railway or the browser completing a Checkout Session. The worker scheduler itself is not started by this isolated test. Those limits remain explicit for release review.
