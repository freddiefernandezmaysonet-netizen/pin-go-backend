# Pin&Go Connect — Railway Staging Topology

## Purpose

Define the exact staging topology required to certify the Channex booking lifecycle and the disabled Global Feed Worker without modifying production.

This document is operational guidance only. It does not create Railway services, deploy code, register webhooks, enable the Global Feed, authorize merge, or authorize production rollout.

## Source revision

Deploy only the current head commit of draft PR #24 from branch:

`recovery/distribution-engine-v2-channex-lifecycle`

Do not deploy `main` for this certification until the PR is approved and merged.

All staging services participating in one certification run must use the same branch and commit.

## Required isolated services

### 1. Pin&Go API Staging

Service name:

`pin-go-api-staging`

Purpose:

- expose `POST /webhooks/channex`;
- authenticate Channex webhooks;
- persist `WebhookEventIngest` records;
- return immediately after durable worker handoff;
- expose the existing Mission Control endpoint for certification evidence.

Start command:

```bash
npm start
```

Runtime role:

```text
PIN_GO_RUNTIME_ROLE=API
```

The repository contract guarantees that `npm start` starts only `src/server.ts`. It must not start the Channex recovery worker or Global Feed Worker inside the API process.

Replicas:

- one API replica during initial certification;
- API scaling can be evaluated later because event claiming is atomic, but it is not part of this certification.

Health checks:

- liveness: `GET /health`;
- readiness, including database connectivity: `GET /ready`;
- Railway health-check path should be `/ready`.

Public domain:

- HTTPS required;
- callback path must end in `/webhooks/channex`.

Example shape only:

`https://<pin-go-api-staging-domain>/webhooks/channex`

### 2. Pin&Go Connect Booking Recovery Worker Staging

Service name:

`pin-go-pms-webhook-recovery-staging`

Purpose:

- own all webhook-triggered Channex booking lifecycle execution;
- recover PENDING and FAILED Channex webhook events;
- release abandoned PROCESSING events;
- fetch Booking Revisions;
- persist canonical reservations;
- ACK only after persistence;
- continue processing later events when one event fails.

Start command:

```bash
npm run worker:pms-webhook-recovery
```

Runtime role:

```text
PIN_GO_RUNTIME_ROLE=RECOVERY_WORKER
```

Replicas:

- exactly one replica for staging certification;
- do not autoscale;
- do not run this command in the API service;
- do not mount it inside another worker.

The worker must not have a public domain or Railway HTTP health check. Its readiness evidence is the boot log and continuous poll activity.

### 3. Pin&Go Connect Global Feed Worker Staging

Service name:

`pin-go-channex-global-feed-staging`

Purpose:

- provide a separately deployable runtime for future global Booking Revision Feed recovery;
- remain online but operationally idle while the activation gate is disabled;
- validate service identity, staging scope, credentials and runtime topology before any real Feed access is authorized.

Start command:

```bash
npm run worker:channex-global-feed
```

Runtime role:

```text
PIN_GO_RUNTIME_ROLE=GLOBAL_FEED_WORKER
```

Mandatory activation gate:

```text
CHANNEX_GLOBAL_FEED_ENABLED=false
```

Replicas:

- exactly one replica during disabled staging certification;
- do not autoscale;
- do not run this command inside the API or recovery-worker service.

Network boundary:

- no public domain;
- no Railway HTTP health check;
- no real Channex Global Feed request while disabled;
- no first worker tick while disabled.

Expected boot evidence:

```text
[channex.global-feed] worker idle because activation is disabled
```

The following lines must remain absent while the activation gate is disabled:

```text
tick completed
tick failed
```

An Online or Active Railway status is expected because the disabled worker keeps the process alive without running a Feed tick.

### 4. PostgreSQL Staging

Service name:

`Postgres-Staging`

Requirements:

- isolated from production;
- same Prisma schema as the deployed branch;
- contains only staging organizations, properties, mappings and reservations;
- accessible by API Staging, Recovery Worker Staging and Global Feed Worker Staging;
- all participating services must resolve to the same physical PostgreSQL server and database.

## Prisma migration status

PR #24 includes five ordered, versioned reconciliation migrations:

```text
20260726223000_reconcile_prisma_migration_history_01
20260726223001_reconcile_prisma_migration_history_02
20260726223002_reconcile_prisma_migration_history_03
20260726223003_reconcile_prisma_migration_history_04
20260726223004_reconcile_prisma_migration_history_05
```

Staging certification established that:

- the existing staging schema already matched `schema.prisma`;
- the five reconciliation migrations were registered as an applied baseline without re-executing their SQL;
- all committed migrations are recorded and finished;
- `prisma migrate deploy` reports no pending migrations;
- schema drift is absent.

Do not run migration resolution, migration deployment or schema changes against production under this topology document.

## Variables shared by the staging runtimes

Required or inherited from the backend runtime:

```text
NODE_ENV=staging
DATABASE_URL
PMS_CREDENTIALS_SECRET
CHANNEX_API_KEY
CHANNEX_API_BASE_URL=https://staging.channex.io
```

The API service additionally requires all normal Pin&Go backend variables needed for authentication, Guest Journey, Access and Mission Control runtime imports. Use staging credentials only.

The recovery and Global Feed workers do not require a public domain or `PORT`.

## Global Feed Worker variable configuration

### Normal variables

Create these as normal manually entered variables:

```text
NODE_ENV=staging
PIN_GO_RUNTIME_ROLE=GLOBAL_FEED_WORKER
CHANNEX_GLOBAL_FEED_ENABLED=false
CHANNEX_API_BASE_URL=https://staging.channex.io
```

### Reference Variables

Create these as Railway Reference Variables. Do not copy secret values into the worker:

```text
DATABASE_URL=${{Postgres-Staging.DATABASE_URL}}
CHANNEX_API_KEY=${{pin-go-api-staging.CHANNEX_API_KEY}}
PMS_CREDENTIALS_SECRET=${{pin-go-api-staging.PMS_CREDENTIALS_SECRET}}
```

A label such as `Postgres-Staging.DATABASE_URL` without the `${{...}}` expression is only literal text and is invalid.

After deployment, verify without printing values that:

- `DATABASE_URL` begins with `postgresql://` or `postgres://`;
- the secret references are present;
- no reference expression remains unresolved;
- no leading or trailing whitespace exists.

The API currently may retain an already-certified manually configured `DATABASE_URL`. When URL strings differ across services, do not infer different databases from a URL hash alone. Confirm the same physical PostgreSQL identity using a sanitized read-only identity fingerprint.

## Recovery worker variables

Recommended certification values:

```text
PMS_WEBHOOK_RECOVERY_POLL_MS=5000
PMS_WEBHOOK_RECOVERY_BATCH_SIZE=20
PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS=8
PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS=0
PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS=30000
PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS=600000
```

Rationale:

- API no longer executes Channex lifecycle work;
- pending events may be processed immediately by the worker;
- ACK failures receive a controlled retry delay;
- abandoned processing leases are released after ten minutes.

## Disabled Global Feed preflight

Run only from a trusted console or SSH command attached to:

`pin-go-channex-global-feed-staging`

Command:

```bash
npm run channex:staging:check-global-feed-preflight
```

Required result:

```text
status=READY_DISABLED
safeToCreateServiceDisabled=true
networkCallsPerformed=false
databaseQueriesPerformed=false
failedChecks=[]
```

The checks must confirm:

- runtime role is `GLOBAL_FEED_WORKER`;
- activation is disabled;
- required credentials are configured;
- Channex base URL is HTTPS and scoped to `staging.channex.io`;
- Railway environment and service names match;
- repository and branch match the draft PR topology.

The preflight must not make Channex network calls or database queries and must not print raw secrets.

## Webhook registration variables

Run the registration command only from a trusted shell attached to the staging environment.

```text
PIN_GO_PROPERTY_ID=<staging Pin&Go property id>
CHANNEX_API_KEY=<staging Channex API key>
CHANNEX_API_BASE_URL=https://staging.channex.io
CHANNEX_WEBHOOK_CALLBACK_URL=https://<api-staging-domain>/webhooks/channex
CHANNEX_STAGING_WEBHOOK_CONFIRMATION=CONFIGURE_CHANNEX_STAGING_WEBHOOK
```

Command:

```bash
npm run channex:staging:configure-booking-webhook
```

The command:

- creates or preserves the connection webhook secret;
- registers or updates the Channex webhook;
- uses event mask `booking`;
- uses `send_data=false`;
- verifies the resulting webhook;
- stores the Channex webhook ID in listing metadata;
- never prints the API key or webhook secret.

## Required data preparation

Before registration:

1. Create a staging organization and host account.
2. Create one staging property.
3. Provision that property in Channex staging.
4. Confirm `PmsConnection` is `CHANNEX` and `ACTIVE`.
5. Confirm every staging room type for the property belongs to one active Channex connection.
6. Confirm `PmsListing.metadata.channexPropertyId` exists.
7. Confirm `PmsListing.externalListingId` contains the Channex room type ID.
8. Confirm the property is not mapped to a second active Channex connection.

## Activation order

1. Deploy PostgreSQL staging.
2. Deploy API Staging from the PR branch with start command `npm start` and `PIN_GO_RUNTIME_ROLE=API`.
3. Configure Railway health check path `/ready` and confirm HTTP 200.
4. Confirm the API public HTTPS domain.
5. Deploy one Recovery Worker Staging replica from the same commit with `PIN_GO_RUNTIME_ROLE=RECOVERY_WORKER`.
6. Confirm recovery-worker boot log shows the intended poll and retry settings.
7. Execute the webhook registration command.
8. Send an unauthenticated synthetic request and confirm HTTP 401.
9. Complete the webhook-driven lifecycle protocol in `docs/channex-staging-booking-lifecycle-certification.md`.
10. Create `pin-go-channex-global-feed-staging` from the same repository, branch and commit.
11. Configure its normal variables and Reference Variables exactly as documented above.
12. Confirm `CHANNEX_GLOBAL_FEED_ENABLED=false` before its first deployment.
13. Deploy exactly one Global Feed Worker replica.
14. Confirm the worker is Online and logs `worker idle because activation is disabled`.
15. Confirm `tick completed` and `tick failed` are absent.
16. Run `npm run channex:staging:check-global-feed-preflight` and require `READY_DISABLED` with no failed checks.
17. Confirm API and Global Feed Worker use the same commit and same physical staging database.
18. Confirm the worker receives the same `CHANNEX_API_KEY`, `PMS_CREDENTIALS_SECRET` and staging Channex host as the API using sanitized fingerprints or non-secret host checks.
19. Stop. Do not enable or query the real Global Feed without a separately reviewed activation protocol and explicit authorization.

## Expected API behavior

For an authenticated Channex webhook:

1. Parse the property identity.
2. Resolve exactly one active Channex connection.
3. Validate `x-pin-go-webhook-secret`.
4. Persist a PENDING webhook event.
5. Hand execution to the standalone recovery worker.
6. Return HTTP 200 without processing the reservation inside the API.

For invalid authentication:

- return HTTP 401;
- do not create a webhook event;
- do not call Channex;
- do not create or modify a reservation.

## Expected recovery-worker behavior

- select only `provider=CHANNEX` events;
- never modify events from Guesty, Cloudbeds, Hostaway, Lodgify or Generic;
- atomically claim PENDING or FAILED events;
- process revisions oldest-first;
- continue the batch after one event fails;
- mark exhausted Channex events DEAD after the configured limit;
- treat an empty Feed as an idempotent success;
- preserve successful persistence while retrying ACK;
- leave active-stay cancellation rejection unacknowledged.

## Expected disabled Global Feed Worker behavior

- resolve configuration and activation state;
- log its sanitized boot configuration;
- remain idle when `CHANNEX_GLOBAL_FEED_ENABLED=false`;
- perform no first tick;
- perform no Global Feed request;
- perform no ACK;
- perform no reservation mutation;
- remain Online through its disabled keepalive;
- stop cleanly on Railway shutdown signals.

## Evidence to retain

For every scenario retain sanitized evidence of:

- branch and commit SHA;
- API, recovery-worker and Global Feed Worker service names;
- all three start commands;
- runtime roles;
- replica counts;
- API `/health` and `/ready` responses;
- non-secret environment variable names and safe values;
- Reference Variable source mappings without resolved secret values;
- webhook registration result without secrets;
- Channex revision ID, booking ID and property ID for webhook lifecycle tests;
- `WebhookEventIngest` status and attempts;
- reservation external provider, external ID and external updated timestamp;
- Distribution persistence audit status;
- Distribution acknowledgement audit status;
- Mission Control lifecycle view;
- Global Feed Worker `READY_DISABLED` preflight result;
- `networkCallsPerformed=false` and `databaseQueriesPerformed=false` from the preflight;
- `failedChecks=[]`;
- `worker idle because activation is disabled`;
- absence of `tick completed` and `tick failed`;
- same physical staging database identity across API and Global Feed Worker;
- matching sanitized fingerprints for `CHANNEX_API_KEY` and `PMS_CREDENTIALS_SECRET`;
- matching Channex staging host.

Do not capture API keys, database URLs, webhook secrets, encryption secrets, full guest contact details or raw payment data.

## Stop conditions

Stop certification immediately if:

- the callback points to production;
- `CHANNEX_API_BASE_URL` is not `https://staging.channex.io`;
- API, recovery worker and Global Feed Worker do not use the intended branch and commit;
- participating services do not use the same physical staging database;
- more than one recovery-worker or Global Feed Worker replica is running;
- Channex events are executed inside the API process;
- the Global Feed Worker starts with `CHANNEX_GLOBAL_FEED_ENABLED=true`;
- the Global Feed Worker logs any tick while disabled;
- the disabled preflight performs a network call or database query;
- the disabled preflight returns a status other than `READY_DISABLED`;
- any Reference Variable is stored as unresolved or literal service-variable text;
- an unauthenticated webhook is accepted;
- `/ready` does not confirm database connectivity;
- ACK occurs before reservation persistence;
- a failed active-stay cancellation is ACKed;
- production data or credentials appear in staging.

## Production gate

This topology does not authorize production deployment.

Production remains blocked until:

1. focused CI is green;
2. all mandatory staging scenarios pass;
3. evidence is reviewed;
4. the read-only production schema preflight is completed and reviewed;
5. the PR receives approval;
6. merge is explicitly authorized;
7. a separate production rollout and rollback plan is approved.

The Global Feed remains separately blocked even after the lifecycle PR is otherwise production-ready. Enabling it requires a dedicated activation protocol, explicit authorization and a controlled staging Feed consultation before any production consideration.
