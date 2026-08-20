# Channex Certified Staging — Deterministic Rollback Point

Recorded: 2026-08-20

This document records the exact Railway staging state that corresponds to the Channex-approved Pin&Go certification baseline. It contains no credentials or secret values.

## Golden source

- Repository: `freddiefernandezmaysonet-netizen/pin-go-backend`
- Branch: `audit/channex-certification-recovery-d7e1a829`
- Golden commit: `d4f6d29c4936c81c7ee428f7824ace94d13804e9`
- Historical certification PR: #36
- Railway environment: `staging-channex-certification`
- Environment ID: `8a78817b-b161-49c8-9bea-cd519611958f`

## Exact successful deployments

### API
- Service: `pin-go-api-staging`
- Service ID: `17365270-2e00-46d2-b2f9-b086ad3a6718`
- Deployment ID: `f3a3b236-3dfb-4da8-8602-9f27c1e2dec0`
- Snapshot ID: `9f42ef0f-aa14-4199-b240-af01f054f83b`
- Commit: `d4f6d29c4936c81c7ee428f7824ace94d13804e9`
- Status when recorded: `SUCCESS`
- Config file: `/railway.api.json`
- Start command: `npm start`
- Pre-deploy: `npx prisma migrate deploy`

### ARI Dispatch
- Service: `pin-go-channex-ari-dispatch-staging`
- Service ID: `bb40941f-fff4-4570-a87d-716ea6a3eb50`
- Deployment ID: `0bec4cc4-dcf9-4b93-9ad1-6881e07d616e`
- Snapshot ID: `fc2f9c16-50ac-47af-9e0b-d2608c2759f8`
- Commit: `d4f6d29c4936c81c7ee428f7824ace94d13804e9`
- Status when recorded: `SUCCESS`
- Config file: `/railway.channex-ari-dispatch.json`

### Global Feed
- Service: `pin-go-channex-global-feed-staging`
- Service ID: `6bbede6b-e38c-4082-bf1d-680efade705b`
- Deployment ID: `4534a33e-311e-4439-9135-2c4baec214aa`
- Snapshot ID: `aa73ae09-29cc-41ce-83d2-7356d521b46e`
- Commit: `d4f6d29c4936c81c7ee428f7824ace94d13804e9`
- Status when recorded: `SUCCESS`
- Start command: `npm run worker:channex-global-feed`

### PMS Webhook Recovery
- Service: `pin-go-pms-webhook-recovery-staging`
- Service ID: `b5db6b70-e82a-43b6-89c2-e747cb953bf1`
- Deployment ID: `099c80aa-a803-4882-b72e-ca0e70307aca`
- Snapshot ID: `9dbcba5b-d8b6-4d4a-99d7-4208b04407a8`
- Commit: `d4f6d29c4936c81c7ee428f7824ace94d13804e9`
- Status when recorded: `SUCCESS`
- Config file: `/railway.pms-webhook-recovery.json`

### Database
- Service: `Postgres-Staging`
- Service ID: `bfafae3d-6b92-4514-84fa-95099b005839`
- Current deployment ID when recorded: `33e5214c-13e2-4f0d-bf0d-8ca4ca24f51a`
- Status when recorded: `SUCCESS`

## Source/config invariant

At the time this rollback point was recorded, the API and all three Channex workers were sourced from `audit/channex-certification-recovery-d7e1a829` and the golden commit above. All five services in the staging environment reported `SUCCESS`.

## Rollback rule

If a production-parity test against `release/channex-production-readiness` shows any behavioral regression, stop the test. Restore the API and all three Channex workers to the golden branch/commit and the exact service configuration recorded above before any further testing.

Do not modify PR #36 or the golden commit as part of rollback. Do not reuse production Channex credentials in this staging environment.
