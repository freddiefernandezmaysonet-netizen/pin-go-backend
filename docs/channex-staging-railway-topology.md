# Pin&Go Connect — Railway Staging Topology

## Purpose

Define the exact staging topology required to certify the Channex booking lifecycle without modifying production.

This document is operational guidance only. It does not create Railway services, deploy code, register webhooks, or authorize merge.

## Source revision

Deploy only the head commit of draft PR #24 from branch:

`recovery/distribution-engine-v2-channex-lifecycle`

Do not deploy `main` for this certification until the PR is approved and merged.

## Required isolated services

### 1. Pin&Go API Staging

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

The repository contract guarantees that `npm start` starts only `src/server.ts`. It must not start the Channex recovery worker inside the API process.

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

Purpose:

- own all Channex booking lifecycle execution;
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

Replicas:

- exactly one replica for staging certification;
- do not autoscale;
- do not run this command in the API service;
- do not mount it inside another worker.

The worker must not have a public domain or Railway HTTP health check. Its readiness evidence is the boot log and continuous poll activity.

### 3. PostgreSQL Staging

Requirements:

- isolated from production;
- same Prisma schema as the deployed branch;
- contains only staging organizations, properties, mappings and reservations;
- accessible by both API Staging and Recovery Worker Staging through the same `DATABASE_URL`.

No Prisma migration is introduced by PR #24. `prisma generate` still runs during installation.

## Shared environment variables

Both API and worker require the same staging database and credential-encryption context.

Required or inherited from the backend runtime:

```text
DATABASE_URL
PMS_CREDENTIALS_SECRET
CHANNEX_API_KEY
CHANNEX_API_BASE_URL=https://staging.channex.io
NODE_ENV=staging
```

The API service additionally requires all normal Pin&Go backend variables needed for authentication, Guest Journey, Access and Mission Control runtime imports. Use staging credentials only.

The worker service does not require a public domain or `PORT`.

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
2. Deploy API Staging from the PR branch with start command `npm start`.
3. Configure Railway health check path `/ready` and confirm HTTP 200.
4. Confirm the API public HTTPS domain.
5. Deploy one Recovery Worker Staging replica from the same commit.
6. Confirm worker boot log shows the intended poll and retry settings.
7. Execute the webhook registration command.
8. Send an unauthenticated synthetic request and confirm HTTP 401.
9. Begin the lifecycle protocol in `docs/channex-staging-booking-lifecycle-certification.md`.

## Expected API behavior

For an authenticated Channex webhook:

1. Parse `property_id`.
2. Resolve exactly one active Channex connection.
3. Validate `x-pin-go-webhook-secret`.
4. Persist a PENDING webhook event.
5. Hand execution to the standalone worker.
6. Return HTTP 200 without processing the reservation inside the API.

For invalid authentication:

- return HTTP 401;
- do not create a webhook event;
- do not call Channex;
- do not create or modify a reservation.

## Expected worker behavior

- select only `provider=CHANNEX` events;
- never modify events from Guesty, Cloudbeds, Hostaway, Lodgify or Generic;
- atomically claim PENDING or FAILED events;
- process revisions oldest-first;
- continue the batch after one event fails;
- mark exhausted Channex events DEAD after the configured limit;
- treat an empty Feed as an idempotent success;
- preserve successful persistence while retrying ACK;
- leave active-stay cancellation rejection unacknowledged.

## Evidence to retain

For every scenario retain sanitized evidence of:

- branch and commit SHA;
- API and worker service names;
- API and worker start commands;
- replica counts;
- API `/health` and `/ready` responses;
- non-secret environment variable names and values;
- webhook registration result without secrets;
- Channex revision ID, booking ID and property ID;
- `WebhookEventIngest` status and attempts;
- reservation external provider, external ID and external updated timestamp;
- Distribution persistence audit status;
- Distribution acknowledgement audit status;
- Mission Control lifecycle view;
- Channex Feed state after ACK.

Do not capture API keys, webhook secrets, full guest contact details or raw payment data.

## Stop conditions

Stop certification immediately if:

- the callback points to production;
- `CHANNEX_API_BASE_URL` is not `https://staging.channex.io`;
- API and worker do not use the same commit;
- API and worker do not use the same staging database;
- more than one recovery worker replica is running;
- Channex events are executed inside the API process;
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
4. the PR receives approval;
5. merge is explicitly authorized;
6. a separate production rollout and rollback plan is approved.
