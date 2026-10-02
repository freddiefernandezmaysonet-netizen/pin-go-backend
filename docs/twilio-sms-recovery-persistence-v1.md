# Twilio SMS recovery V1: persistence integration

## Candidate scope

This continues PR #341 from cb92eb3f. Recovered the previously unreferenced
store/test blobs 2bb1e628 and c9c6015a without replacing the approved bounded
retry policy. Adds an additive journal migration and multi-file Prisma model,
strict compilation and a disposable PostgreSQL workflow. Validation is pending
for this candidate; prior 100 policy tests do not certify this persistence code.

The internal store registers an already persisted 30005 by exact MessageLog SID
and verified organization/property/reservation. It records the original failure,
first-failure anchor, fixed delay/spacing and fingerprint without copying the
phone, SMS body or access code. Duplicate registration leaves those values intact.

The only retry is consumed transactionally before provider I/O. Advisory and row
locks plus compare-and-set prevent two cooperating claimers from consuming the
same slot. A claimed/unknown outcome remains held after executor restart; this
store never resends it. A trusted later submission may attach a separate retry
SID without changing the original MessageLog or resetting the budget. SID reuse,
foreign scope, changed source/contact/dates and ambiguous source mappings fail
closed. A due subsequent message yields this old retry durably, without blocking
that separate message. Pure-policy decisions still require current readiness.

The journal intentionally has no cascading foreign keys; scope is revalidated
against current MessageLog -> Reservation -> Property when registering/claiming.
If those records are removed or moved, retained journal evidence cannot authorize
a new claim. This is not a general schema admission or deletion-policy change.

## Validation boundaries

The PostgreSQL suite refuses any URL other than the exact loopback CI database
and also requires TWILIO_RECOVERY_DISPOSABLE_DB=1. The workflow uses a fresh
postgres:16 container and runs actual versioned migrations, not db push. It tests
concurrent registration/claims, restart, rollback, boundaries, stale scope/content,
unknown provider outcome and SID conflicts. No app/worker entrypoint is imported.
Readiness is injected and provider responses simulated: these tests do not prove
current production consent/access-readiness or real Twilio delivery.

## Not yet activated or complete

No server/worker imports this store. Signed callback ingestion, early/unmatched
receipts and replay reconciliation, retry outcome processing, host-action writes,
actual dispatcher/readiness and scheduled-message coordination remain integration
work. CLAIMED is a durable slot, not permission to send; its dispatcher must still
revalidate consent/current recipient/content/access at the provider boundary.
No masked body may be replayed. Existing runtime/manual retry paths are unchanged
and have not yet been fenced by this store. A held unknown claim requires durable
reconciliation/attention, not automatic budget reset. YIELDED needs a consumer of
the next message's real outcome; it must never mean delivered or wait forever.

Keep the live case out of fixtures. The reported noon and 2pm failures remain two
distinct logical messages, not two retries. Missing email plus failed access SMS
requires host visibility alongside the permitted retry; this slice does not yet
create that host action. Never revoke or regenerate access merely for SMS failure.

No merge, deployment, production migration/configuration, real SMS/email/provider
or hardware call. API and workers are separate deployment/configuration gates.
