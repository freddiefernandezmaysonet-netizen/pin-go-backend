# Host reservation push — rollout pending

## Confirmed production gap (2026-10-20)
Railway project Pin&Go Deploy / production has `host-mobile-push-once` (74923d46-b0a6-45ce-b577-cdeac029191e). Its command is a fixed build-7 certification send, restart NEVER, no cron, source 54aed0f. This is not the continuous notification dispatcher. No production settings were changed during this audit.

## Changes
- Atomic PostgreSQL trigger captures only reservations inserted after migration; no historical backfill. Direct Booking waits for PAID; active channel/manual reservations qualify without assuming payment is collected by Pin&Go. Past checkouts and cancelled stays cannot dispatch.
- Immutable first confirmation timestamp and existing per-source/device/user unique ledger prevent repeat webhook/sync sends. Transaction rollback removes the event. Uncertain provider sends remain non-replayable.
- New informational NEW_RESERVATION preference, generic push, existing quiet hours/session/tenant/property authorization. Reservation is rechecked at network boundary.
- Authenticated reservation resolver requires an accepted delivery belonging to the current user/org/property. Payload cannot choose a reservation. Destination also fetches its current authorized detail.
- `--loop` runs serial cycles every 15 seconds, with sanitized failure logs and graceful SIGTERM. `--once` and maintenance remain separate.

## Before activation
1. Review and merge backend and Host changes. Ask Freddie before any EAS build.
2. Apply migration through the normal controlled deployment. Deploy backend including resolver before enabling new reservation preferences.
3. Install the updated Host build before selecting New reservations. Older clients do not understand the new kind. Existing preferences are NOT silently changed.
4. Replace the certification-only service command with `node --import tsx src/workers/host-mobile-push.worker.ts --loop`, using the reviewed commit and the existing database/token-key/provider configuration. Do not copy the fixed certification script.
5. Verify actual secret configuration; connector audit returned names only, not values. Set explicit delivery enabled, exact property ID allowlist, UTC NOT_BEFORE set at activation (no alert backlog). New reservations additionally require HOST_MOBILE_PUSH_RESERVATIONS_ENABLED=true. Guest messages require HOST_MOBILE_PUSH_MESSAGES_ENABLED and the existing message verifier settings. See host-mobile-push-messages.ts. Do not claim messages work without this verification.
6. Worker scope remains the existing explicit property allowlist (max 50), not automatic global enrollment. Expand verified property scope deliberately before general public launch. Do not represent this canary as global coverage.
7. Verify connected device and saved preferences. With authorization, create a synthetic reservation, observe ledger/provider receipt and physically confirm foreground/background/tap destination. Repeat webhook must not send twice. Separately verify each existing category with authorized synthetic signals; do not alter real incidents or send test alerts to unrelated Hosts.
8. Rollback: disable delivery/stop worker; keep immutable event/ledger history. Never reset UNKNOWN/SENDING to queued. No App Store review submitted.

## Verification
Backend focused typecheck; 17 policy/delivery/session tests; loop lifecycle test; PGlite executes the actual migration and repository SQL, covering capture, unpaid-to-paid, replay, no backfill, rollback, tenant isolation, opt-out/cancellation fences and destination ownership. Mobile typecheck and 34 notification tests passed.
Run database harness with an installed @electric-sql/pglite (or PGLITE_MODULE pointing to its dist/index.js):
`node --import tsx --test tests/host-reservation-push.test.mjs`
No production database or provider is used by this harness. Physical receipt remains pending.
