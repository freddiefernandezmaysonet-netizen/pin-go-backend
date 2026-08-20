# Channex Production Railway Audit — 2026-08-19

Read-only audit. No Railway configuration, service, variable, deployment, or activation was changed.

## Production project

Railway project: `Pin&Go Deploy`
Environment: `production`

Existing production services include the Pin&Go API, Postgres, reservation/access/device/message workers, and existing PMS watchdog infrastructure.

The production environment does **not** currently contain dedicated services for:
- `pin-go-channex-global-feed`
- `pin-go-pms-webhook-recovery`
- `pin-go-channex-ari-dispatch`

Those three services exist in `staging-channex-certification` and their latest audited deployments are successful.

## Staging reference topology

### Channex Global Feed
- Source branch: `audit/channex-certification-recovery-d7e1a829`
- Start command: `npm run worker:channex-global-feed`
- Required variable names include `DATABASE_URL`, `CHANNEX_API_BASE_URL`, `CHANNEX_API_KEY`, `PMS_CREDENTIALS_SECRET`, `NODE_ENV`, `PIN_GO_RUNTIME_ROLE`, and `CHANNEX_GLOBAL_FEED_ENABLED`.

### PMS webhook recovery
- Source branch: `audit/channex-certification-recovery-d7e1a829`
- Railway config: `/railway.pms-webhook-recovery.json`
- Required variable names include `DATABASE_URL`, `CHANNEX_API_BASE_URL`, `CHANNEX_API_KEY`, `PMS_CREDENTIALS_SECRET`, `NODE_ENV`, and `PIN_GO_RUNTIME_ROLE`.

### Channex ARI dispatch
- Source branch: `audit/channex-certification-recovery-d7e1a829`
- Railway config: `/railway.channex-ari-dispatch.json`
- Required variable names include `DATABASE_URL`, `CHANNEX_API_BASE_URL`, `CHANNEX_API_KEY`, and `CHANNEX_ARI_DISPATCH_ENABLED`.

## Production API migration gap

The current production API Railway configuration uses:
- Build: `npm install && npx prisma generate`
- Pre-deploy: `npx prisma generate`
- Start: `npx tsx src/server.ts`

It does not currently execute `npx prisma migrate deploy` as part of the Railway deployment configuration.

This is a release blocker for the Channex production-readiness branch because the branch introduces required database migrations. The migration must be an explicit rollout step before new ARI code or workers are activated.

## Current production deployment observation

The latest Railway deployment attempt for `pin-go-backend` from `main` commit `24217f6ec64349d5b14f304759f171a596db9b62` is recorded as `FAILED`.

A prior deployment from `main` commit `b55e0e1fd96868f5a4ad0498ac8b60800bead149` is recorded as `SUCCESS`.

The same latest-main deployment attempt is recorded as failed across multiple existing production worker services. No useful build/deploy log entries were returned by the Railway connector for that failed deployment, so this audit does not assign a root cause.

Before Channex production rollout, confirm the current production baseline is healthy and resolve or explain the failed latest-main deployment attempt. Do not treat the Channex release as the fix for an unrelated baseline deployment failure.

## External Channex gate

Per the approved production-onboarding instructions, production activation remains gated on the White Label subscription and Evan creating the production Channex account. After that, Pin&Go creates the production API key and production traffic must use `https://app.channex.io` rather than staging.

No production Channex credentials are stored in this document.
