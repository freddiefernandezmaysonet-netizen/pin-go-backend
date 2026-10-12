# Pin AI hybrid billing sandbox certification — 2026-10-12

Railway project `PinGo Stay-Time Certification`, environment `certification`, already contains the Stripe sandbox credential. It was reused through the existing one-shot function; no credential was extracted or exposed, and the production project and stay-time API were not changed.

The production membership provider passed four real Stripe cases using SDK 14.25.0/API 2023-10-16: pending item deletion, draft item deletion, credit against an open invoice, and customer credit after a USD 1.00 test-card payment. Each item and reversal replay reused its original ID. All four cancellations ended with net Pin AI USD 0.00. A subsequent GET verified the paid customer's credit balance was -100 cents and all four synthetic subscriptions were canceled. Earlier unused prices and zero-value draft invoices were closed. The function was restored to its prior expired read-only source.

The sandbox exposed a real compatibility defect: Stripe rejects `credit_amount=0`. The provider now omits that field for credits against unpaid invoices, while sending the paid portion for partially/fully paid invoices. This correction and its regression assertion are in backend PR #407; the candidate is `a1a03428cdae8b6cf7856f36d1c1a189ff3eb6be` and all 58 checks passed.

Actual execution receipts are in `src/pin-ai/fixtures/hybrid-membership-stripe-sandbox-20261012.json`. Certification deployment: `0722541b-f30d-46c1-aad1-f139869020de`. Cleanup/read-back deployment: `f3b73c03-f56a-42b1-bdfa-063d193bb91c`. These are real Stripe provider tests; PostgreSQL concurrency/persistence was certified separately. Public HTTP, signed webhook delivery and the live worker were not exercised by this script.

## Complete financial provider certification

After the user completed Stripe-hosted onboarding, GET verification confirmed charges enabled with no requirements outstanding. The synthetic account remains `acct_1UPbUgRqmXnirYx7`, with losses owned by Stripe, fees paid by the connected account and no Stripe Dashboard. No existing host account was modified.

Run `qa-pin-ai-hybrid-1c0d6f8b-951a-4ad0-947f-1552146284b5`, deployment `463feb0d-63bb-481c-b582-9cba5f634167`, passed all seven real Stripe cases. Direct Booking guest payments stayed at 10000 cents and the total application fee was 600 cents (100 Pin AI plus 500 other commission). Cancellation with guest refunds of 0/5000/10000 cents returned application fees of 100/350/600 cents respectively: full Pin AI fee return plus proportional other commission. Each payment/refund replay returned its original ID; read-only reversal reconciliation matched. The pending/draft/open/paid membership cases also passed again, with net Pin AI charge zero.

A separate GET-only cleanup run confirmed all three guest payments fully refunded, all three total application fees fully returned, all four subscriptions canceled, their price/product inactive, and the paid customer's credit balance -100 cents. Evidence is in `src/pin-ai/fixtures/hybrid-complete-stripe-sandbox-20261012.json`, including cleanup deployment ID and the actual resource IDs. The one-shot Railway function was subsequently left idle with no Stripe requests.

These results certify the production Stripe provider against the real sandbox configuration. They do not certify public HTTP, signed webhooks, reservation persistence or the live worker as one combined end-to-end flow. That remains a release validation requirement. Production billing remains disabled and the implementation PRs remain unmerged.

The earlier blocked attempts are retained in `src/pin-ai/fixtures/hybrid-direct-stripe-sandbox-20261012.json` as historical evidence. Their onboarding blocker has now been resolved. No identity, bank details or short-lived onboarding link is retained in the certification receipts.

Membership-only tests are independently implemented in `src/scripts/certify-pin-ai-membership-sandbox.ts`; that runner has no Connect identity, bank or TOS mutation. Paid production collection remains disabled, and PRs #407 and dashboard #217 remain unmerged.

References: https://docs.stripe.com/connect/testing ; https://docs.stripe.com/api/credit_notes/create ; https://docs.stripe.com/api/invoiceitems/create .
