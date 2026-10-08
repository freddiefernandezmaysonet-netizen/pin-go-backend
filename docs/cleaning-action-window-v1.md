# Cleaner work action windows — block 2

Implemented only on local branch `agent/cleaner-account-access-v1`; no push, merge or deployment. No schema migration or provider calls were added in this block.

The existing cleaner portal uses one read-only window resolver for button rendering and the transaction that records start/completion. Each transaction rechecks the active reservation/property, confirmed assignment, active same-organization Staff/PropertyStaff, scheduled start and next occupancy. It runs at Serializable isolation and locks the departure reservation. Serialization conflicts fail without an action write; the user can refresh/retry. Native concurrent-session verification remains pending.

- Start is permitted at the scheduled work start and strictly before its upper bound. Access activation timing/status never moves the scheduled work start. The default upper bound is the earlier of the calculated access-window end, the saved StaffAssignment end and the next check-in. This block implements the agreed default; a configurable extra late-start allowance and Pin AI access extension remain later work.
- Completion requires explicit start, cannot precede it, and is permitted immediately afterward without waiting out the committed duration. With a next arrival, the same upper bound applies, exclusive of the closing instant. Without any next arrival selected by the existing cleaner-window occupancy rule, completion remains available after access expiry; a new start does not.
- The occupancy lookup matches the current access service, includes overlaps and excludes cancelled reservations/the departure itself. An earlier arrival caps action deadlines, and a changed departure schedule rejects a stale work snapshot.
- Work actions do not create, activate, extend, revoke or otherwise update NFC/access grants or StaffAssignment. Access lifecycle status is not proof of completion and does not decide whether an action may be recorded. Only the explicit successful completion action records completion.
- Repeated recorded actions preserve the first timestamp without making another write. Existing terminal mobile completion documents remain readable and identical on repeated requests.

Buttons use the same policy and show a disabled state before/after the allowed time or when window validation is unavailable. A monotonic elapsed-time clock updates an already-open page, checks again on submit and handles visibility/page restoration. The server still decides every submitted action using its own current time after reading the transaction context; the client cannot override it with a posted timestamp. Spanish/English follow Staff preference. No new SMS family or email was added.

The dashboard's initial task list still opens this guarded portal. Direct dashboard action controls, unified offer acceptance/cancellation, late-start configuration, Pin AI recovery/extensions and message consolidation are subsequent blocks.

Validation: 72 action/access-window/snapshot/consent/language tests, 19 mobile route response tests, 5 SQL lifecycle checks in disposable PGlite, strict targeted TypeScript and backend bundle. The SQL checks confirm rejected actions do not write work timestamps, NFC expiry does not complete work, and completion leaves saved access/NFC unchanged. The SQL engine is embedded PostgreSQL; native PostgreSQL row-lock/phantom/concurrency behavior and production delivery remain uncertified.

Reusable opt-in database test: `src/services/cleaning-action-window.database.test.ts`, using only `CLEANER_ACCOUNT_TEST_DATABASE_URL` for a loopback database named `cleaner_account_test`.

Property/task checklists are now implemented in local block 3; see `cleaning-checklist-v1.md`. This does not change the work/access rules above.
