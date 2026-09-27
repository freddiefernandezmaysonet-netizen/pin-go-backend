# Host Incident Foundation V1 — implementation candidate

Backend only; no production changes or certification. Builds on backend
`fd93534541b6648ef31679c5b521ed0af7f7f728`. The existing guest canary remains
independent and unchanged. No real messages, host acknowledgements or incident
closures have been performed by this implementation task.

## API

All responses use no-store and all host operations require the existing
session-bound Dashboard authentication plus a fresh active same-organization
administrator lookup. Existing cookie-mutation origin protection and per-process
rate limiting are reused. Global abuse controls remain an infrastructure concern.

- GET `/api/dashboard/pin-ai/incidents?before=<cursor>`: scoped page (50 cases).
- GET `/api/dashboard/pin-ai/incidents/:reference?after=<sequence>`: current
  canonical state, reported facts, acknowledgement and up to 100 host events.
- POST `/api/dashboard/pin-ai/incidents/:reference/actions`: exact fields
  `requestId`, `expectedVersion`, `operation`, `text`. Operations are NOTE,
  ACKNOWLEDGE (empty text), PUBLISH (exact guest-visible text), RESOLVE (internal
  outcome note). No AI execution endpoint is included yet.
- GET `/api/public-booking/manage/:guestToken/pin-ai/incident-updates?after=<cursor>`:
  guest-authorized projection of PUBLISH events only. Existing chat history is
  neither replaced nor modified. Dashboard/guest UI consumption comes later.

One thread per canonical incident; read-only access never materializes a thread
or changes responsibility. The first explicit action creates it transactionally.
Acknowledgement, message insertion, version and transition audit commit together.
Resolution uses canonical upsert on the single operational key and records
HOST_REPORTED_RESOLVED with an internal encrypted outcome note. It does not
independently prove a repair. Guest recurrence keeps the existing new-case behavior.

All host commands serialize on the same canonical issue lock used by the guest
report path. Duplicate request ids return the original event; reuse with different
content/actor/version fails. Conflicting versions fail without partial writes.
Host access can continue after checkout; guest credentials retain their original
expiry and ACTIVE reservation/property restrictions.

## Default-off configuration and retention

No values below have been set in production:

- PIN_AI_HOST_INCIDENT_ENABLED=true
- PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS=explicit IDs
- PIN_AI_HOST_INCIDENT_RESERVATION_IDS=explicit IDs
- PIN_AI_HOST_INCIDENT_KEY_ID=current key identifier
- PIN_AI_HOST_INCIDENT_KEYS=JSON map of key identifiers to 32-byte hex keys

The independent organization AND reservation allowlists fail closed. Server-owned
AES-256-GCM keys bind content to organization, thread, sequence and audience. Never
use the guest token as a host key. Supply keys through secret configuration; do not
log or commit them. Rotation keeps old key versions available until ciphertext is
migrated. Missing/wrong keys return unavailable, not empty history.

Messages are retained with their incident and cascade on canonical issue deletion.
There is no automatic TTL or new purge endpoint; production retention duration and
key backup/rotation must be decided before activating host data collection. Actor
ids are preserved as audit identifiers even if an account is subsequently removed.

## Migration and release boundary

Migration 20260927180000 adds two tables and a relation to OperationalIssue. It has
not been applied to production. The disabled router returns before touching these
tables. CI applies the migration to an isolated database seeded from the PR base
schema, then runs real PostgreSQL service/API tests, strict compilation and emitted
build. PostgreSQL tests intentionally refuse a nonlocal/non-test database.

UI, host AI turns, read cursors, delegation settings, automatic guest summaries,
notification link changes and supervisor execution are future slices. No change
to existing guest runtime schemas, email sender, reservation/action/payment or
device behavior is included. This backend foundation is not the completed host chat.

Ready, merge, migration/deploy, secrets, flags and real communication still require
explicit approval. Keep host capability disabled until Dashboard controls and
end-to-end audience isolation have been certified.
