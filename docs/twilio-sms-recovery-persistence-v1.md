# Twilio SMS recovery V1: persistence integration

## Status

Internal, unmounted persistence extension to PR #341. No production behavior
changes. The approved policy remains unchanged: one delayed retry per logical
message, and later eligible scheduled communications remain independent.

The first persistence head 1e0533282ca7a8753b36a6333e249a6288c9ea80 passed all ten
triggered workflows, including real PostgreSQL migrations, strict compilation
and registration/claim/restart/rollback scenarios. That validates the store, not
the subsequent access-gap extension. The latter must pass its own exact-head CI.

## Durable retry journal

Recovered the previously unreferenced store/test blobs 2bb1e628 and c9c6015a.
An additive migration and separate Prisma model introduce TwilioSmsRecovery.
The store registers only an already persisted, exactly correlated 30005 and
verifies MessageLog -> Reservation -> Property scope. It preserves the original
failure, its first-failure anchor, fixed delay/spacing and source fingerprint
without copying the phone, message body or access code into the journal.
Repeated registration cannot reset those values.

The only retry is consumed transactionally before provider I/O. Advisory and row
locks plus compare-and-set allow exactly one cooperating claimant. A claimed or
unknown outcome remains held after restart, not blindly resent. A trusted late
submission can record a separate retry SID without changing the original
MessageLog/SID or restoring budget. Foreign scope, changed source/contact/dates,
SID reuse and ambiguous persisted mappings fail closed. A near-term scheduled
message yields the old retry durably but does not block the separate message.

The journal has no cascading relations: scope IDs are revalidated on registration
and claim, and removed/moved source records cannot authorize a new claim. Source
fingerprints are internal consistency evidence, not public anonymization tokens.
This is not a general deletion-policy or schema-admission change.

## Persisted critical access-communication action

persistTwilioSmsAccessGap reads exact persisted access-SMS failure evidence. It
requires current tenant/reservation/active access, matching recipient, supported
30005 failure and a genuinely absent email destination. It uses the existing
canonical upsertOperationalIssue inside its caller transaction to create one
HOST-visible CRITICAL/ACTION_REQUIRED item and its transition atomically.

The action has a separate key from the retry-owning workflow. Thus host attention
can coexist with the single permitted delayed retry; neither MessageLog, access,
reservation nor retry budget is modified by the projector. Concurrent duplicate
projections preserve one issue/transition and never reopen an existing resolved
action. A scheduled future grant is not evidence of physical entry or handset
delivery. An email address being present is not proof that email was delivered;
that case is deliberately returned for separate delivery-evidence handling.

Only allowlisted technical correlation is recorded. No guest phone, SMS body,
access code, provider error free text or private link enters the issue metadata.
The service checks existing source data; user reports are not converted into
signed provider receipts. The live incident/SID is not a test fixture.

## Validation boundaries

Both DB suites refuse anything except the exact loopback CI database and require
TWILIO_RECOVERY_DISPOSABLE_DB=1. The workflow uses fresh PostgreSQL 16 and actual
versioned migrations, not db push. No app/worker entrypoint, live provider or
production secrets are used. Eligibility is injected and provider responses are
simulated. The access-gap suite exercises the real canonical issue writer and
checks concurrent duplicates, tenant isolation, preserved resolved state,
rollback of issue plus transition, and actual retry-claim coexistence.

Local syntax transpilation of the two added access-gap modules has no diagnostics;
full semantic compilation and PostgreSQL execution are CI-only in this environment.
Do not describe syntax transpilation as complete local TypeScript certification.

## Remaining release gates

No server/worker imports these services. Signed callback ingestion, early/unmatched
and out-of-order receipts, retry-outcome reconciliation, atomic binding between
receipt and recovery registration, real dispatcher/readiness and cross-worker
coordination still need integration. CLAIMED is a durable retry slot, not a send
authorization. Existing runtime/manual retry paths remain unchanged and unfenced.
No masked log body may be replayed. A held ambiguous claim requires reconciliation
or attention, never a reset. YIELDED needs the next message's actual outcome, not
indefinite waiting or an assumption of delivery.

The host projector now persists canonical operational data when explicitly
invoked, but is not mounted, does not send host email and has no tested Dashboard
button or recovery-resolution flow. Integration must verify visibility under the
actual active Mission Control read model and define supported close/resolution
semantics, including subsequent successful receipt and host confirmation.

The reported noon/2pm failures remain two different logical messages, not two
retries. Missing email plus failed access SMS requires attention alongside the
permitted retry. Never revoke or regenerate access solely for SMS failure.

No merge/deployment/production migration/configuration, actual SMS/email/provider
or hardware call. API and workers remain separate rollout/configuration gates.
