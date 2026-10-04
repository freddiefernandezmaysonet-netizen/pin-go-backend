# Airbnb operational access delivery V1 — review candidate

User priority on October 3, 2026: deliver Pin&Go access communications through
Airbnb before integrating Pin AI, and replace guest email/SMS for that source.
No production configuration or deployment is changed by this branch.

## Scope

| Message | New destination for enabled reservations |
| --- | --- |
| PRECHECKIN | Exact Airbnb booking thread, within four hours before arrival |
| GUEST_ACCESS_PASSCODE | Exact Airbnb booking thread, only after canonical access release |
| CHECKOUT | Exact Airbnb booking thread, within one hour after scheduled checkout |

Guest passcode email/SMS producers, precheckin producers, checkout producer,
legacy access-link sender, automatic retry worker, dashboard SMS retry and the
Guest Journey communications adapter all yield to the same route. The access
outbox materializer stops creating email/SMS rows for enabled reservations.
The reservation worker scans the explicit canary independently of guest contact
availability and of whether access provisioning has already completed.

Host/staff notices and other reservation sources retain their existing behavior.
This is not a change to financial, damage-notice or review communications.
Pin AI is deferred, not removed from the project.

## Activation

Default off. Set these consistently on API and reservation/message retry workers
only after deployment and review of a real test reservation:

- `CHANNEX_AIRBNB_ACCESS_ENABLED=true`
- `CHANNEX_AIRBNB_ACCESS_ORGANIZATION_IDS`: exact organization IDs
- `CHANNEX_AIRBNB_ACCESS_PROPERTY_IDS`: exact local Pin&Go property IDs
- `CHANNEX_AIRBNB_ACCESS_RESERVATION_IDS`: exact local reservation IDs, maximum 50

All three scopes must match; there is no wildcard. This first version provides a
controlled test rollout, not blanket activation for all Airbnb reservations.
It uses existing Connection Center credentials and READY property/group mapping.
No new database migration is required; MessageLog's primary key fences each send.
Disabling the flag restores legacy ownership, so rollback needs review of already
accepted notifications before resuming legacy delivery.

## Delivery guarantees and limitations

- Scope derives from persisted source=Airbnb and externalProvider=CHANNEX.
- Exactly one thread must match Reservation.externalId as its booking relation.
  The remote property and provider are validated. Inquiries cannot receive codes.
- The canonical GUEST/PASSCODE_TIMEBOUND grant must be ACTIVE, applied, encrypted,
  match both current stay dates, and have RELEASED reservation evidence.
- Cancelled/unpaid reservations and expired credentials do not send.
- ES/EN text includes validity start/end, property timezone and unlock key.
- One deterministic receipt per reservation/type/stay/credential prevents parallel
  email, SMS and scan producers from sending the same notification twice.
- Receipt body contains only type and booking ID. No plaintext code, guest token,
  incoming message text or raw provider response is logged/persisted by this sender.
- An ambiguous provider result remains AIRBNB_UNKNOWN or AIRBNB_SENDING. It is
  never automatically sent again. SENT means Channex acceptance, not guest delivery.
- No email/SMS fallback within enabled scope. Failed old rows become OBSOLETE;
  current evidence, never their stored message body, drives the new delivery.
- Preflight failures are logged with bounded codes by the reservation scan.
  Missing or ambiguous threads require operator attention; automatic thread
  creation and provider-side delivery webhooks are not part of this candidate.
- The previous Casa Collores tests were inquiry threads without booking relations.
  They cannot certify this access delivery. A linked test booking and actual
  released test grant are required before activation. Serena Studio is excluded.

## Validation

22 focused tests passed: routing, contactless reservations, 12 concurrent
producers, persisted replay, unknown provider outcomes, persistence failure,
cross-property/booking rejection, closed/inquiry threads, inactive/unpaid
reservations, stale/ambiguous grants, changed credential, language/validity and
suppression at initial/retry entrypoints. These are isolated fixtures, not a
live provider or PostgreSQL concurrency certification.

Strict messaging compilation and the existing broader guest-registration
compilation pass. API and both worker ESM bundles compile. Existing outbox,
communications adapter and passcode SMS suites pass. All seven guest-registration
integration tests pass (the local HTTP test required localhost socket permission).

Official documentation checked October 3, 2026:
https://docs.channex.io/api-v.1-documentation/messages-collection
The documented booking relation, thread/property relation and thread message
POST are used without changing the certified booking-ingestion core.
