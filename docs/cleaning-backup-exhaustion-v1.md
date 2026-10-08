# Cleaning backup exhaustion — durable operational attention

Implemented locally for all current/new properties. No migration, provider message, access modification or deployment is included.

## Audit and behavior

The withdrawal service previously returned `NO_VIABLE_BACKUP` without persisting that outcome. The reservation audit separately represented a declined offer as host attention but did not cover cancelled/expired exhaustion reliably.

Cancellation, decline and expiry now commit the terminal offer, closure of unstarted work, replacement selection and operational attention in one serializable transaction. If a viable configured candidate remains, a pending offer is created and previous withdrawn-offer attention is marked superseded. That means the old request is closed; replacement acceptance is still required. If no candidate remains, Mission Control receives `CLEANING_BACKUPS_EXHAUSTED`, `ACTION_REQUIRED`, responsible actor `HOST`. No automatic next step is advertised because a Pin AI recovery executor is not implemented yet.

The canonical key remains `CLEANING_CONFIRMATION:<withdrawn-offer-id>`, shared with the existing reservation audit. Repeated withdrawal returns the existing recorded outcome without creating another issue or transition. A previously confirmed/resolved offer is explicitly reopened if its cancellation exhausts coverage. A subsequent episode uses its new offer's key; earlier resolved history remains resolved.

Replacement acceptance closes active attention on prior withdrawn offers, including the legacy declined/pending conditions, within its transaction. It means coverage was restored, not that cleaning was started/completed. Access incidents remain independent. No host email or cleaner SMS is added by this block.

The reservation audit writes its mapped items through a transaction that acquires the same canonical advisory lock before reading the current issue. It preserves committed exhaustion and superseded-offer outcomes rather than overwriting them with a stale pending/declined/confirmed snapshot. Access items still use the existing operational persistence contract.

## Limits and remaining work

This is durable exception tracking, not a Pin AI recovery agent. Host-configured recovery policies, delay/incomplete declarations, access extension without a next arrival, and the audit of existing cleaner notification timing remain pending. Adding a configured cleaner does not silently confirm availability: a new offer and explicit acceptance are required. This block does not add a host assignment editor.

Native PostgreSQL concurrency and real phone/SMS/NFC certification remain pending an authorized release. PGlite validates actual SQL transactions and rollback but does not certify native multi-session locking.

## Validation

Disposable SQL coverage verifies superseded pending attention, active replacement tracking, transactional rollback on incident persistence failure, exhausted decline/cancellation, stable scope/key, replay without duplicate transitions or messages, explicit replacement acceptance, preservation against stale reservation audits, reopening an already resolved availability workflow, and one active exception after a second exhaustion episode. Relevant operational lifecycle, account/language/mobile response regressions and compilation are run before the local commit.

On 2026-10-07, all 8 SQL test entries, the 40-test operational/account/language/mobile regression run, and the 10-test reopen/deduplication/auto-close run passed. Cleaner/account strict TypeScript (including the reservation audit integration), backend bundle and whitespace checks passed.
