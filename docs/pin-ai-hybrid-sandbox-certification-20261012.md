# Pin AI hybrid billing sandbox certification — 2026-10-12

Railway project `PinGo Stay-Time Certification`, environment `certification`, already contains the Stripe sandbox credential. It was reused through the existing one-shot function; no credential was extracted or exposed, and the production project and stay-time API were not changed.

The production membership provider passed four real Stripe cases using SDK 14.25.0/API 2023-10-16: pending item deletion, draft item deletion, credit against an open invoice, and customer credit after a USD 1.00 test-card payment. Each item and reversal replay reused its original ID. All four cancellations ended with net Pin AI USD 0.00. A subsequent GET verified the paid customer's credit balance was -100 cents and all four synthetic subscriptions were canceled. Earlier unused prices and zero-value draft invoices were closed. The function was restored to its prior expired read-only source.

The sandbox exposed a real compatibility defect: Stripe rejects `credit_amount=0`. The provider now omits that field for credits against unpaid invoices, while sending the paid portion for partially/fully paid invoices. This correction and its regression assertion are in backend PR #407; the candidate is `a1a03428cdae8b6cf7856f36d1c1a189ff3eb6be` and all 58 checks passed.

Actual execution receipts are in `src/pin-ai/fixtures/hybrid-membership-stripe-sandbox-20261012.json`. Certification deployment: `0722541b-f30d-46c1-aad1-f139869020de`. Cleanup/read-back deployment: `f3b73c03-f56a-42b1-bdfa-063d193bb91c`. These are real Stripe provider tests; PostgreSQL concurrency/persistence was certified separately. Public HTTP, signed webhook delivery and the live worker were not exercised by this script.

## Direct Booking pending explicit approval

The old sandbox host has platform-owned losses. A new synthetic account `acct_1UPbUgRqmXnirYx7` was created with the actual onboarding configuration: fees paid by the account, losses owned by Stripe, Stripe collection of requirements, and no Stripe Dashboard. Its charges remain disabled pending test verification. No payments were created on it, and no existing host account was modified.

Automatic approval review rejected an attempt to complete its verification using Stripe's documented synthetic identity and bank tokens and to accept its test terms. That rejected source was not deployed. The complete proposal is `src/scripts/certify-pin-ai-hybrid-sandbox.ts`: before any mutation it pins the sandbox platform ID, asserts synthetic ownership, and persists an attempted-run guard. The Railway entry also checks project/environment, rejects live credentials and expires after one hour.

After explicit user authorization, the proposed test fills only this synthetic account with Stripe's successful verification tokens, a test bank number and test terms acceptance. It then certifies Direct Booking payments of 10000 cents with a 600-cent total application fee (100 Pin AI plus 500 other commission), under zero/50%/100% guest refunds. Pin AI must be returned in full and other commissions proportionally, with payment/refund replay and read-only reconciliation checks. The host's controller configuration is not changed. All remaining synthetic guest funds and application fees must be returned after recording evidence.

Membership-only tests are independently implemented in `src/scripts/certify-pin-ai-membership-sandbox.ts`; that runner has no Connect identity, bank or TOS mutation. Paid production collection remains disabled, and PRs #407 and dashboard #217 remain unmerged.

References: https://docs.stripe.com/connect/testing ; https://docs.stripe.com/api/credit_notes/create ; https://docs.stripe.com/api/invoiceitems/create .
