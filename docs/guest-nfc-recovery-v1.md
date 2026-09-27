# Guest NFC recovery V1 — prepared for review, not deployed

Base: backend main `fe4aee5586c94d069e6a33004c3ef187c64893cf`.

## Verified incident

Production reservation PG-2026-000051 had two GUEST NFC assignments in FAILED,
each with retryCount=1, null provisionedAt, and the same recorded error:
`Error: TTLock errcode=1 errmsg=failed or means no`.
The failures were recorded on 2026-09-26 at 17:00:28Z and 17:00:47Z, before
the Pin AI checkout extension. Neither error received the RETRYABLE prefix,
so the normal recovery query excluded both assignments. The generic rejection
does not independently establish the cause of the original NFC failure.

The subsequent PIN extension had separate evidence of gateway error -2012.
Do not conflate that PIN response with the original NFC error.

## Changes

- Recognize that exact generic NFC error for guest cards, including existing
  failed records. Keep terminal configuration/window conflicts non-retryable.
- Limit guest activation to five total attempts, waiting 1, 5, 15 and 30 minutes
  between failed attempts. Select only due work in the database query.
- Use a compare-and-set claim including status, attempt count and update time
  to arbitrate the reservation worker and NFC watchdog.
- Replace the watchdog's oldest-20 scan and unsafe separate activation path
  with the canonical provisioning service. ENDED/ACTIVE rows cannot become
  activation candidates. Canonical non-guest scheduling rules remain intact.
- Recover guest cards using current reservation dates, checking card overlap
  against the full desired window. Persist ACTIVE and new dates only after
  provider success. Guest provider calls have a 20-second request deadline;
  other callers retain their prior transport behavior.
- Persist a deduplicated HOST/ACTION_REQUIRED OperationalIssue for guest
  failures, including failures from before this change. Use the existing
  Mission Control issue projection. Close after successful recovery; distinguish
  expired/cancelled access from successful activation. Reporting failure must
  not turn a provider-confirmed activation into FAILED.

## Validation

`npm run test:guest-nfc-recovery` covers rejection classification, retry budget,
current-date recovery, competing claims, overlap, cancellation, expiry,
retired cards, provider failure, reporting failure, issue deduplication and
resolution, canonical operational validation, and transport timeout.

`npm run typecheck:guest-nfc-recovery` checks the changed services, watchdog,
tests and transitive imports. An emitted TypeScript build uses the same scope.
Existing operational issue, reservation reconciliation and guest readiness
tests are also run. Provider calls and database access are mocked in these
tests; this is not live TTLock or PostgreSQL end-to-end certification.

## Deployment boundary and follow-up

No merge, deployment, variable changes, production writes or lock commands
are authorized by this branch preparation. Deployment would allow eligible
existing FAILED guest cards to retry, including reservations beyond 000051;
review this operational effect before approving deployment.

No schema migration or new secret is required. Stripe, Pin AI, OTA, Messages
and the Health Center gateway scheduler are unchanged. The new escalation is
an OperationalIssue shown through existing Mission Control, not an email/SMS
notification and not a change to the Health Center gateway status badge.

The Health Center IN_STAY monitoring gap remains a separate follow-up.
Before declaring the production incident recovered, verify provider activation
and current access periods for both guest cards and the PIN. Do not repeat
the reservation payment to test recovery.
