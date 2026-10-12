# Pin AI hybrid billing sandbox certification — 2026-10-12

Railway project `PinGo Stay-Time Certification`, environment `certification`, already contains the Stripe sandbox credential. It was reused through the existing one-shot function; no credential was extracted or exposed, and the production project and stay-time API were not changed.

The production membership provider passed four real Stripe cases using SDK 14.25.0/API 2023-10-16: pending item deletion, draft item deletion, credit against an open invoice, and customer credit after a USD 1.00 test-card payment. Each item and reversal replay reused its original ID. All four cancellations ended with net Pin AI USD 0.00. A subsequent GET verified the paid customer's credit balance was -100 cents and all four synthetic subscriptions were canceled. Earlier unused prices and zero-value draft invoices were closed. The function was restored to its prior expired read-only source.

The sandbox exposed a real compatibility defect: Stripe rejects `credit_amount=0`. The provider now omits that field for credits against unpaid invoices, while sending the paid portion for partially/fully paid invoices. This correction and its regression assertion are in backend PR #407; the candidate is `a1a03428cdae8b6cf7856f36d1c1a189ff3eb6be` and all 58 checks passed.

Actual execution receipts are in `src/pin-ai/fixtures/hybrid-membership-stripe-sandbox-20261012.json`. Certification deployment: `0722541b-f30d-46c1-aad1-f139869020de`. Cleanup/read-back deployment: `f3b73c03-f56a-42b1-bdfa-063d193bb91c`. These are real Stripe provider tests; PostgreSQL concurrency/persistence was certified separately. Public HTTP, signed webhook delivery and the live worker were not exercised by this script.

## Direct Booking blocked on Stripe-hosted terms acceptance

The user explicitly authorized synthetic identity/bank verification and test terms acceptance. Three controlled attempts targeted only synthetic account `acct_1UPbUgRqmXnirYx7`. The first exposed inconsistent published identity tokens (`id_number` and `ssn_last_4`); the runner now submits only the full successful test ID. Stripe then rejected API acceptance of terms because `controller.requirement_collection=stripe`. The runner now leaves acceptance to Stripe-hosted onboarding rather than changing the controller.

The identity and bank update succeeded. GET verification in deployment `01eedfba-1441-4dc6-a533-9f4ad96f0320` showed charges disabled with exactly `tos_acceptance.date` and `tos_acceptance.ip` outstanding, losses owned by Stripe, fees paid by the connected account, and no Stripe Dashboard. No Direct Booking payment was created and no existing host was modified. An onboarding link was created, but the browser tool timed out before a form could be submitted. That short-lived link is not retained in the repository.

The direct verification receipt is `src/pin-ai/fixtures/hybrid-direct-stripe-sandbox-20261012.json`. Direct certification remains incomplete until the account's terms are accepted through Stripe's hosted form and the runner passes all three refund scenarios. Production remains untouched. The one-shot function was restored to its previous expired read-only source after these attempts.

The complete proposal is `src/scripts/certify-pin-ai-hybrid-sandbox.ts`: it pins the sandbox platform, asserts synthetic ownership, persists an attempted-run guard and tests three payments of 10000 cents with application fee 600 (100 Pin AI and 500 other commission), under zero/50%/100% guest refunds. Expected fee reversals are 100/350/600 cents, with unchanged guest payment total, replay and reconciliation checks. The Railway wrapper rejects live credentials and expires after one hour. These expectations have not yet been observed against this Connect account.

Membership-only tests are independently implemented in `src/scripts/certify-pin-ai-membership-sandbox.ts`; that runner has no Connect identity, bank or TOS mutation. Paid production collection remains disabled, and PRs #407 and dashboard #217 remain unmerged.

References: https://docs.stripe.com/connect/testing ; https://docs.stripe.com/api/credit_notes/create ; https://docs.stripe.com/api/invoiceitems/create .
