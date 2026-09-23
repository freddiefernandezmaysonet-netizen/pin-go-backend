# Property Protection V1 — exact payment authorization (backend foundation)

This Draft adds persistent, explicit guest consent. It does **not** charge, hold,
capture, refund, create a PaymentIntent, send/queue an email, or start a financial
engine. No production migration or deployment is part of this certification.

Existing `ACCEPTED` responses and booking-time `damagePaymentConsent` retain their
old meanings. Neither is backfilled into the new authorization table. The guest
must already have explicitly accepted the case through the existing response
flow, then separately opt into exact-amount payment authorization.

## API contract

Existing public-booking base +
`/manage/:guestToken/property-protection-case/payment-authorization`:

- `GET ?language=en|es`: fresh exact terms, consent text and existing authorization
  summary; defaults to the reservation's preferred language. No writes.
- `POST`: `{action, version, claimRevision, amountMinor, currency, language,
  consent:true}` copied from the GET terms. Action must be
  `ACCEPT_AND_AUTHORIZE_PAYMENT`; version must be
  `PROPERTY_PROTECTION_PAYMENT_AUTHORIZATION_V1`. No tenant/account/timestamp
  fields accepted. Integer minor units only. USD only in V1.
- Both return `Cache-Control: no-store`; errors do not log bearer tokens or bodies.
- 404 for missing/expired guest token; null expiry remains valid. No token rotation
  or extension here. 400 for malformed input; 409 for ineligible/stale terms.
- Success records authorization only and returns `NO_CHARGE_MADE`.

Preconditions reuse #227: strictly after checkout, direct booking, protection
enabled with CARD_ON_FILE, approved/notified open case and ACCEPTED response,
supported currency and approved amount within accepted liability. Additionally,
booking consent and policy currency/cap must agree, saved method must be READY,
and reservation account must equal the property's organization's current account.
Provider readiness is **not** checked and no payment eligibility is asserted.

The server derives scope and binds a canonical SHA-256 revision to the full case
description/evidence, exact amounts, liability, approval/notification timestamps,
checkout, property/tenant/reservation/case/account and saved method. The guest sees
no internal account/customer/method identifiers. The immutable application record
stores this snapshot, exact bilingual consent text chosen, version and server time.
Rows have no update API. A unique case key plus serializable transactions and row
locks make duplicate submissions idempotent. Bounded retries handle serialization
conflicts. Changed terms cannot overwrite prior consent; revision mismatch remains
visible. Case closure and dispute block new/repeated authorization submissions.

Deletion is restricted for authorized cases to preserve this audit record. No
historical cases are modified. The additive migration defines constraints; only
the disposable CI PostgreSQL service applies it during this PR.

## Deliberately pending

- Guest-facing UI to display these exact terms and an unchecked explicit consent
  control, distinct from existing nonfinancial response actions. This PR alone
  does not expose a new button in production.
- Revocation/re-consent policy for a changed case (V1 fails closed).
- Payment execution, attempt persistence, provider verification, SCA and collection
  reconciliation. Any future engine must reload current trusted state, compare
  authorization scope/revision and run eligibility again; this record alone is
  never permission to bypass those checks.

Tests use only synthetic records in a hard-coded, opt-in loopback CI database.
No customer cases, canary reservations, Stripe requests or delivery providers.
