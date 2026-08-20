# Channex Production Readiness — Pin&Go

Status: release preparation only. This document does not authorize deployment or activation.

## Release branch

`release/channex-production-readiness`

The branch is based on the current `main` production baseline and promotes only the Channex runtime deltas that were validated during certification recovery.

## Required production runtime topology

Pin&Go production requires four independent runtime roles for Channex:

1. **API** — `pin-go-backend`
   - Receives authenticated `/webhooks/channex` events.
   - Persists Channex webhook events durably.
   - Does not send Channex booking events through the generic PMS queue.

2. **PMS webhook recovery worker**
   - Start command: `npm run worker:pms-webhook-recovery`
   - Railway config: `/railway.pms-webhook-recovery.json`
   - Recovers durable Channex webhook events and invokes the certified Booking Revision lifecycle.

3. **Channex Global Feed worker**
   - Start command: `npm run worker:channex-global-feed`
   - Railway config: `/railway.channex-global-feed.json`
   - Activation is fail-closed unless `CHANNEX_GLOBAL_FEED_ENABLED=true` (or equivalent accepted true value).
   - Uses Booking Revision Feed only; Booking Find is not an allowed ingest mechanism.

4. **Channex ARI dispatch worker**
   - Start command: `npm run worker:channex-ari-dispatch`
   - Railway config: `/railway.channex-ari-dispatch.json`
   - Activation is fail-closed unless `CHANNEX_ARI_DISPATCH_ENABLED=true` (or equivalent accepted true value).

## Required production variable names

Do not commit secret values.

API:
- `DATABASE_URL`
- `CHANNEX_API_BASE_URL`
- `CHANNEX_API_KEY`
- `PMS_CREDENTIALS_SECRET`

PMS webhook recovery worker:
- `DATABASE_URL`
- `CHANNEX_API_BASE_URL`
- `CHANNEX_API_KEY`
- `PMS_CREDENTIALS_SECRET`
- `NODE_ENV=production`
- `PIN_GO_RUNTIME_ROLE` as appropriate for the worker runtime contract

Global Feed worker:
- `DATABASE_URL`
- `CHANNEX_API_BASE_URL`
- `CHANNEX_API_KEY`
- `PMS_CREDENTIALS_SECRET`
- `NODE_ENV=production`
- `PIN_GO_RUNTIME_ROLE` as appropriate for the worker runtime contract
- `CHANNEX_GLOBAL_FEED_ENABLED=true` only at the activation gate

ARI dispatch worker:
- `DATABASE_URL`
- `CHANNEX_API_BASE_URL`
- `CHANNEX_API_KEY`
- `CHANNEX_ARI_DISPATCH_ENABLED=true` only at the activation gate

## Database migration gate

The release introduces durable ARI semantics that require database migrations before the new runtime is activated:

- `20260808120000_add_channex_ari_changed_fields`
- `20260809233000_add_nightly_stay_restriction_overrides`
- `20260810143500_repair_property_nightly_restriction_table`

Production must run `prisma migrate deploy` against the production database before any new Channex worker is activated. `prisma generate` alone is not a migration.

After migration, verify that Prisma generation succeeds and that `DistributionOutboxEvent.changedFields` and `PropertyNightlyRestriction` are available before ARI dispatch is enabled.

## Certified ARI contract promoted by this release

- Availability supports canonical single-date values and inclusive `date_from` / `date_to` ranges.
- Rates & Restrictions supports incremental changed-field payloads.
- Consecutive equal values are compacted into inclusive ranges.
- Full Sync still contains complete supported rate/restriction fields.
- Incremental rate-only updates do not drag Min Stay / Max Stay values.
- Incremental Min Stay updates emit only `min_stay_arrival` and `min_stay_through`.
- Calendar overrides persist per-night Min Stay / Max Stay and emit exact-date ARI intents.
- Full Sync is blocked only while another correlated Full Sync is actually in flight; there is no arbitrary 24-hour cooldown after completion.

## Certified Booking Receiving contract promoted by this release

Allowed Channex ingest mechanisms:
- `BOOKING_REVISION_BY_ID`
- `BOOKING_REVISION_FEED`

Explicitly forbidden as booking-ingest mechanisms:
- Booking Find
- Booking By ID
- Booking List polling

Channex webhooks are durable signals. They are stored first and processed by the recovery lifecycle; Global Feed is the recovery/completeness path.

## Provisioning contract

New Channex properties are provisioned with:
- `property_type: apartment` for Pin&Go's current vacation-rental inventory classification.
- Auto Availability on confirmation: ON.
- Auto Availability on modification: OFF.
- Auto Availability on cancellation: OFF.
- Pin&Go remains the source of truth for absolute availability after lifecycle changes.

## Railway production gap confirmed during readiness audit

The production environment currently does not contain dedicated production services for:
- Channex Global Feed
- PMS webhook recovery
- Channex ARI dispatch

Equivalent staging services exist and are healthy. Production services must be created only after the release branch passes CI and the production migration/activation plan is explicitly authorized.

The existing production API service currently runs `prisma generate` during build/pre-deploy but does not run `prisma migrate deploy`. This must be addressed as an explicit migration gate; do not assume schema migrations are applied by deployment.

## Activation order

1. CI must pass on the release branch.
2. Review release diff against `main`.
3. Confirm live Channex API endpoint/key are configured without exposing secret values.
4. Apply production database migrations.
5. Deploy API with Channex workers still inactive/not created.
6. Smoke-test API health and existing Pin&Go flows.
7. Create/deploy PMS webhook recovery worker.
8. Create/deploy Global Feed worker with activation disabled first, then explicitly enable it.
9. Create/deploy ARI dispatch worker with activation disabled first, then explicitly enable it.
10. Provision the first live Channex property only after all runtime roles are healthy.
11. Run a controlled Full Sync and verify both Availability and Rates & Restrictions deliveries.
12. Verify a controlled booking create/modification/cancellation lifecycle and acknowledgement.

## Stop conditions

Stop rollout immediately if any of the following occurs:
- Prisma migration or generation failure.
- Ambiguous Channex property mapping.
- Booking revision acknowledgement failure that persists after recovery.
- ARI delivery enters DEAD state.
- Global Feed or webhook recovery shows repeated terminal failures.
- Existing Pin&Go reservation/access/guest-journey behavior regresses.

No production activation should proceed from this document alone; explicit deployment authorization is required.
