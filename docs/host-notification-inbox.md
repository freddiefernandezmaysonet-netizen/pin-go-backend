# Host notification history

The native Host inbox projects metadata from provider-accepted dispatch ledger
rows from the last 30 days. It is not a provider delivery receipt or proof that
a phone displayed an alert. Queued/skipped-before-send work is excluded. A later
provider failure does not erase the original handoff from history. Resolving a
source also does not erase that historical alert.

`GET /api/host-mobile/notifications/inbox?filter=all|unread&cursor=...` returns
25 event/property cards, a keyset cursor and an exact unread count across the
current 30-day window. Multiple device sends collapse to one card per Host/event.
Only the current actor/organization and currently active properties in that
organization qualify. The existing native session/Host authorization and registry
gate apply. No new delivery activation, scheduler or send occurs on an inbox read.

`POST /api/host-mobile/notifications/inbox/read` accepts only eventId/propertyId.
An INSERT/SELECT verifies an eligible history row at the write boundary. The
composite organization/Host/property/event key makes repeats idempotent and keeps
the first read timestamp across new sign-ins and phones. It never acknowledges a
guest message, changes an OperationalIssue, or suppresses future notification
dispatch. Other Hosts have independent read state. Missing/foreign events return
404. Provider tickets, tokens, guest bodies and delivery/device identifiers are
never exposed by these endpoints.

The additive migration creates HostMobileNotificationRead and the ledger inbox
index. Roll out the migration/API before a matching client. The mobile bell reads
on focus; inbox has explicit Refresh and All/Unread filters. It does not poll or
modify OS badge counts. The UI uses generic English category text, the authorized
property name and the event date. View update opens the existing authorized area
(Pin AI/Messages/cleanings/properties); it does not promise an exact source detail.

Local checks: strict backend typecheck; validation unit test; SQL projection,
pagination, duplicate-device handling, exact read persistence and scope checks in
isolated embedded PostgreSQL (PGlite, UTC). Real Prisma/PostgreSQL integration and
native simulator UI run in the PR workflows. Production migration/deployment and a
new physical build remain outside this preparation. Automatic push stays off.

## Cross-feature CI scope

PR475 also supplies a pinned inbox verifier for the four commercial/Airbnb
certifications that trigger on schema changes. It accepts only this repository,
PR, branch, reviewed base, exact changed-file set, appended read model, ledger
index and additive SQL. It rejects forks, other branches/bases, extra runtime
files, destructive SQL and edits to every pre-existing schema definition.
The checkout must have the exact candidate tree. Explicit git freezes cover
sales services/tests, OTA distribution/transports, PMS, workers and server.

Only the initial feature-scope check selects this independent verification.
Existing commercial/Airbnb allowlists are unchanged. Every downstream fingerprint,
typecheck, runtime and PostgreSQL contract remains enabled. CRM and recovery
jobs apply the actual inbox SQL to their populated base-schema databases and
require full Prisma schema parity and preserved sales sentinels before their
original regression suites. Six verifier tests cover positive and negative
scope, schema, migration and checkout cases. No production operation is added.
