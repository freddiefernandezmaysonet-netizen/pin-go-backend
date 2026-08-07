# Pin&Go Connect — Channex Staging Booking Lifecycle Certification

## Status

This protocol is for Channex staging only.

It does not authorize:

- merge;
- production deployment;
- production API keys;
- production properties;
- real guest personal data;
- multiple recovery-worker replicas;
- multiple Global Feed Worker replicas;
- enabling the independent Channex Global Feed Worker;
- querying the real Global Feed through that independent worker.

The webhook-driven booking lifecycle and the independent Global Feed Worker are separate certification scopes.

## Certification targets

### A. Webhook-driven booking lifecycle

Validate the complete lifecycle:

```text
Channex booking event
→ authenticated Pin&Go webhook
→ durable WebhookEventIngest
→ independent recovery worker
→ exact Booking Revision pull or property-scoped Feed recovery
→ canonical Reservation persistence
→ Distribution audit
→ Channex revision ACK
→ Mission Control observability
```

### B. Independent Global Feed Worker while disabled

Validate the separately deployable runtime without allowing Feed execution:

```text
Railway service boot
→ runtime identity validation
→ explicit activation gate false
→ worker remains Online but idle
→ no first tick
→ no Global Feed request
→ no database mutation
```

The independent Global Feed Worker does not participate in the new-booking, modification, cancellation, persistence-before-ACK or deduplication scenarios in this document while it is disabled.

## Official behavior represented by this implementation

- The `booking` event covers new, modified and cancelled Booking Revisions.
- The webhook is a trigger; Pin&Go does not treat webhook order as booking order.
- `send_data=false` delivers a minimal trigger containing `event`, `user_id` and `property_id`.
- Pin&Go pulls the specific Booking Revision when a revision ID is available.
- The recovery worker may use the Booking Revision Feed when a webhook-triggered event contains only the property ID.
- Recovery-worker Feed results are processed oldest-first.
- ACK is sent only after Pin&Go has persisted the revision.
- The independent Global Feed Worker is a separate runtime and remains blocked by `CHANNEX_GLOBAL_FEED_ENABLED=false` during this certification.
- A successful disabled-worker preflight does not authorize a real Global Feed request.

## Required staging topology

Use an isolated staging database and three independent runtime services built from draft PR #24.

All three runtimes must use the intended branch and current head commit.

### API service

Service name:

```text
pin-go-api-staging
```

Runs the regular Pin&Go API and exposes:

```text
POST /webhooks/channex
GET /api/dashboard/properties/:id/mission-control
```

Start command:

```bash
npm start
```

Runtime role:

```text
PIN_GO_RUNTIME_ROLE=API
```

The API stores the durable event and hands execution to the recovery worker. It must not execute the independent recovery loop or the Global Feed Worker.

### Recovery worker service

Service name:

```text
pin-go-pms-webhook-recovery-staging
```

Run exactly one replica:

```bash
npm run worker:pms-webhook-recovery
```

Runtime role:

```text
PIN_GO_RUNTIME_ROLE=RECOVERY_WORKER
```

Do not mount this command inside the API service or another worker.

This is the only worker authorized to execute the webhook-driven lifecycle scenarios in this protocol.

### Independent Global Feed Worker service

Service name:

```text
pin-go-channex-global-feed-staging
```

Run exactly one replica:

```bash
npm run worker:channex-global-feed
```

Runtime role and mandatory activation gate:

```text
PIN_GO_RUNTIME_ROLE=GLOBAL_FEED_WORKER
CHANNEX_GLOBAL_FEED_ENABLED=false
```

Required behavior:

- service reaches Railway Online or Active state;
- boot log reports `activationEnabled: false`;
- log contains `worker idle because activation is disabled`;
- `tick completed` is absent;
- `tick failed` is absent;
- no real Global Feed request occurs.

The service must have no public domain and no HTTP health check.

### Required shared configuration

The runtimes must use the same isolated staging database and compatible values for:

```text
DATABASE_URL
PMS_CREDENTIALS_SECRET
CHANNEX_API_KEY
CHANNEX_API_BASE_URL=https://staging.channex.io
NODE_ENV=staging
```

The Global Feed Worker must receive secrets through Railway Reference Variables instead of copied secret values:

```text
DATABASE_URL=${{Postgres-Staging.DATABASE_URL}}
CHANNEX_API_KEY=${{pin-go-api-staging.CHANNEX_API_KEY}}
PMS_CREDENTIALS_SECRET=${{pin-go-api-staging.PMS_CREDENTIALS_SECRET}}
```

A value such as `Postgres-Staging.DATABASE_URL` without the `${{...}}` syntax is literal text, not a valid resolved reference.

When the API and a worker use different textual PostgreSQL URLs, a URL hash alone is not sufficient to prove different databases. Use a sanitized, read-only physical-database identity fingerprint to confirm the same PostgreSQL server and database.

## Boundary between the two Feed paths

This protocol uses two distinct concepts that must not be conflated:

1. **Webhook recovery Feed path:** the recovery worker may query the Booking Revision Feed as part of processing a durable webhook event that only identifies the property. This path is part of the certified booking lifecycle.
2. **Independent Global Feed Worker:** a dedicated polling runtime intended for future global recovery. It remains disabled and has not queried the real Feed during this certification.

Evidence from one path must never be presented as evidence that the other path was activated.

## Disabled Global Feed Worker preflight

Run only from a trusted console or SSH command attached to:

```text
pin-go-channex-global-feed-staging
```

Command:

```bash
npm run channex:staging:check-global-feed-preflight
```

Required sanitized result:

```text
status=READY_DISABLED
safeToCreateServiceDisabled=true
networkCallsPerformed=false
databaseQueriesPerformed=false
failedChecks=[]
```

Every check must pass:

- runtime role is `GLOBAL_FEED_WORKER`;
- activation is explicitly disabled;
- `DATABASE_URL`, `CHANNEX_API_KEY` and `PMS_CREDENTIALS_SECRET` are configured;
- Channex URL is HTTPS and scoped to `staging.channex.io`;
- Railway environment is `staging-channex-certification`;
- Railway service is `pin-go-channex-global-feed-staging`;
- repository and branch match the certification topology.

The preflight must not call Channex, query the database or print raw secrets.

## Staging data preconditions

Before registering the webhook, confirm all of the following:

- the Pin&Go property exists in the staging database;
- the property is `ACTIVE`;
- one active Channex `PmsConnection` is associated with the property;
- all room-type listings for the property resolve to that same connection;
- listing metadata contains the correct `channexPropertyId`;
- each Channex room type is mapped to the correct Pin&Go property;
- the callback URL is public HTTPS and ends exactly in `/webhooks/channex`;
- no production identifiers or credentials are used.

## Register or update the staging webhook

Set the variables only in the operator shell or protected staging environment. Do not commit them.

PowerShell example:

```powershell
$env:PIN_GO_PROPERTY_ID="<PIN_GO_STAGING_PROPERTY_ID>"
$env:CHANNEX_API_KEY="<CHANNEX_STAGING_API_KEY>"
$env:CHANNEX_API_BASE_URL="https://staging.channex.io"
$env:CHANNEX_WEBHOOK_CALLBACK_URL="https://<STAGING_API_HOST>/webhooks/channex"
$env:CHANNEX_STAGING_WEBHOOK_CONFIRMATION="CONFIGURE_CHANNEX_STAGING_WEBHOOK"

npm run channex:staging:configure-booking-webhook
```

Expected sanitized result:

```json
{
  "ok": true,
  "provider": "PIN_GO_CONNECT",
  "environment": "STAGING",
  "operation": "CREATED | UPDATED | RECREATED",
  "eventMask": "booking",
  "sendData": false,
  "isActive": true,
  "verified": true
}
```

The command must never output:

- the Channex API key;
- the webhook secret;
- encrypted PMS credentials;
- guest data.

## Webhook authentication gate

The registered Channex webhook must send:

```text
x-pin-go-webhook-secret: <connection secret>
```

### Negative authentication test

Send a minimal request without the secret:

```bash
curl -i -X POST "https://<STAGING_API_HOST>/webhooks/channex" \
  -H "Content-Type: application/json" \
  -d '{"event":"booking","user_id":"test","property_id":"<CHANNEX_PROPERTY_ID>"}'
```

Expected:

```text
HTTP 401
INVALID_WEBHOOK_AUTHENTICATION
```

Verify that no `WebhookEventIngest` row was created.

### Invalid property test

Send an authenticated request with an unmapped Channex property ID.

Expected:

```text
HTTP 404
CHANNEX_PROPERTY_MAPPING_NOT_FOUND
```

### Ambiguous mapping test

Only in an isolated disposable database state, map the same Channex property ID to two active Channex connections.

Expected:

```text
HTTP 409
CHANNEX_PROPERTY_MAPPING_AMBIGUOUS
```

Restore the valid mapping before continuing.

## Scenario 1 — New booking

Create a new staging OTA booking for the mapped property.

### Expected event lifecycle

1. Channex calls the authenticated Pin&Go webhook.
2. API returns HTTP 200 after durable event storage.
3. `WebhookEventIngest` becomes `PENDING`.
4. The independent recovery worker claims it as `PROCESSING`.
5. Pin&Go pulls the Booking Revision or uses the webhook recovery Feed path.
6. A single Reservation is created using the stable Channex booking ID.
7. `Reservation.externalUpdatedAt` equals the revision `inserted_at`.
8. Distribution persistence audit becomes `SUCCESS`.
9. Channex ACK succeeds.
10. Distribution ACK audit becomes `SUCCESS`.
11. The webhook event becomes `PROCESSED`.
12. The acknowledged revision disappears from the Channex Feed.

### PASS criteria

- exactly one Pin&Go reservation;
- correct property mapping;
- correct check-in and check-out;
- correct guest details from the staging fixture;
- stable external booking ID, not revision ID;
- no duplicate AccessGrant caused by retry;
- persistence audit present;
- ACK audit present;
- Mission Control reports no host action required;
- independent Global Feed Worker remains disabled and does not participate.

## Scenario 2 — Booking modification

Modify dates or guest details on the same staging booking.

### PASS criteria

- no second reservation is created;
- the existing reservation is updated;
- `externalUpdatedAt` advances to the modification revision timestamp;
- access dates are reconciled through the canonical ingestion path;
- the modification revision receives ACK only after persistence;
- Mission Control returns the revision as acknowledged;
- independent Global Feed Worker remains disabled and does not participate.

## Scenario 3 — Booking cancellation before stay start

Cancel the staging booking before check-in.

### PASS criteria

- the existing reservation becomes `CANCELLED`;
- the cancellation is not represented as a new reservation;
- applicable downstream access reconciliation runs through canonical ingestion;
- persistence audit is `SUCCESS`;
- ACK audit is `SUCCESS`;
- webhook event is `PROCESSED`;
- independent Global Feed Worker remains disabled and does not participate.

## Scenario 4 — Cancellation rejected for an active stay

Use a disposable staging reservation whose stay has already started, then deliver a cancellation revision.

### Expected

- Pin&Go retains the existing operational status according to the canonical active-stay guard;
- `lastIngestError` records `CANCEL_REJECTED_ACTIVE_STAY`;
- Distribution audit records `CHANNEX_CANCELLATION_NOT_APPLIED`;
- no ACK is sent;
- the webhook event becomes `FAILED` and remains visible for host review;
- Mission Control reports `WAITING_FOR_HOST_REVIEW`.

This scenario is PASS only when the revision remains unacknowledged.

## Scenario 5 — Out-of-order revisions

Generate two modifications and deliver or process the newer signal before the older signal.

### PASS criteria

- webhook recovery Feed processing is oldest-first;
- a revision older than `Reservation.externalUpdatedAt` cannot overwrite current reservation state;
- an already persisted revision can still complete ACK recovery;
- final reservation state matches the newest revision;
- each persisted revision has an independent audit identity.

## Scenario 6 — Duplicate minimal webhook and empty Feed

After all revisions have been acknowledged, send the same authenticated property-only trigger again.

### PASS criteria

- the recovery worker queries the webhook recovery Feed path;
- an empty property Feed is treated as an idempotent success;
- event becomes `PROCESSED` with zero revisions;
- the event does not consume all recovery attempts;
- Mission Control does not create a false incident;
- this test does not activate the independent Global Feed Worker.

## Scenario 7 — API restart before worker processing

1. Stop the recovery worker.
2. Trigger a valid authenticated booking webhook.
3. Confirm the API stores the event as `PENDING`.
4. Restart the API if desired.
5. Start the independent recovery worker.

### PASS criteria

- the stored event survives API restart;
- the recovery worker processes the event without another webhook;
- reservation persistence and ACK complete normally.

## Scenario 8 — Recovery-worker interruption during processing

1. Allow the recovery worker to claim an event as `PROCESSING`.
2. Stop the recovery worker before completion.
3. Wait past `PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS`.
4. Restart the recovery worker.

### PASS criteria

- stale `PROCESSING` is released to `FAILED`;
- the event is reclaimed;
- attempts increment predictably;
- reservation remains idempotent;
- ACK eventually succeeds;
- other events in the batch are not blocked.

## Scenario 9 — Booking persisted, later lifecycle step failed

Use controlled staging fault injection outside production to fail a post-persistence operation after the Reservation transaction commits.

### PASS criteria

- Reservation exists with the revision timestamp;
- event remains recoverable;
- retry with equal timestamp reruns canonical ingestion idempotently;
- persistence audit becomes `SUCCESS`;
- ACK is sent only after recovery completes.

Do not simulate this by editing production data.

## Scenario 10 — ACK failure and retry

Use controlled staging-only network fault injection that allows the revision fetch but temporarily blocks the ACK request.

### Expected first attempt

- Reservation is persisted;
- persistence audit is `SUCCESS`;
- ACK audit is `FAILED` with `CHANNEX_REVISION_ACK_FAILED`;
- event becomes `FAILED`;
- Mission Control reports `RETRY_ACKNOWLEDGEMENT`.

### Expected retry

- reservation is not duplicated;
- persistence audit remains `SUCCESS` and is not downgraded;
- ACK succeeds;
- ACK audit becomes `SUCCESS`;
- event becomes `PROCESSED`.

## Disabled Global Feed Worker certification

This is an independent certification step and does not replace any lifecycle scenario above.

### Required checks

1. Confirm exactly one `pin-go-channex-global-feed-staging` replica.
2. Confirm the service uses the same repository, branch and commit intended for the staging run.
3. Confirm `NODE_ENV=staging`.
4. Confirm `PIN_GO_RUNTIME_ROLE=GLOBAL_FEED_WORKER`.
5. Confirm `CHANNEX_GLOBAL_FEED_ENABLED=false` with explicit source.
6. Confirm Reference Variables resolve without exposing values.
7. Confirm the worker and API resolve to the same physical staging PostgreSQL database.
8. Confirm the worker receives the same `CHANNEX_API_KEY` and `PMS_CREDENTIALS_SECRET` as the API using sanitized fingerprints.
9. Confirm both use `https://staging.channex.io`.
10. Run the disabled preflight and require `READY_DISABLED` with no failed checks.
11. Confirm `worker idle because activation is disabled`.
12. Confirm no `tick completed` and no `tick failed`.

### PASS criteria

```text
serviceOnline=true
activationEnabled=false
activationSource=EXPLICIT
preflightStatus=READY_DISABLED
safeToCreateServiceDisabled=true
networkCallsPerformed=false
databaseQueriesPerformed=false
failedChecks=[]
realGlobalFeedConsulted=false
```

## Mission Control verification

Request:

```text
GET /api/dashboard/properties/<PIN_GO_PROPERTY_ID>/mission-control
```

Validate `item.distributionLifecycle`:

- provider is `PIN_GO_CONNECT`;
- no Channex credential or secret is exposed;
- healthy acknowledged revisions do not appear as action required;
- recoverable failures appear under `automaticRecovery`;
- exhausted or host-owned failures appear under `actionRequired`;
- references use OTA or booking references, not internal event IDs.

The disabled Global Feed Worker should not create a Mission Control incident because it performs no tick and no Feed request.

## Evidence package

Capture the following for each lifecycle scenario, redacting secrets and guest PII:

- UTC start and completion timestamps;
- Pin&Go property ID;
- Channex property ID;
- OTA reservation reference;
- Booking Revision ID;
- stable Channex booking ID;
- webhook event status progression;
- attempts count;
- Reservation ID and reservation number;
- `externalUpdatedAt`;
- Distribution persistence audit decision ID and status;
- Distribution ACK audit decision ID and status;
- webhook recovery Feed state before and after ACK;
- Mission Control lifecycle summary;
- recovery-worker logs for recovery scenarios;
- HTTP status for authentication tests.

Capture the following separately for the disabled Global Feed Worker:

- service name;
- branch and commit SHA;
- start command;
- replica count;
- runtime role;
- `CHANNEX_GLOBAL_FEED_ENABLED=false` without exposing unrelated variables;
- Reference Variable source mappings without resolved secret values;
- sanitized physical-database identity match with the API;
- matching sanitized fingerprints for `CHANNEX_API_KEY` and `PMS_CREDENTIALS_SECRET`;
- Channex base host `staging.channex.io`;
- preflight status `READY_DISABLED`;
- `safeToCreateServiceDisabled=true`;
- `networkCallsPerformed=false`;
- `databaseQueriesPerformed=false`;
- `failedChecks=[]`;
- boot log `worker idle because activation is disabled`;
- absence of `tick completed` and `tick failed`;
- explicit statement that the real Global Feed was not consulted.

Never include:

- API keys;
- database URLs;
- webhook secret values;
- encryption secret values;
- encrypted credentials;
- payment card data;
- complete guest contact information.

## Certification decision

### PASS

All mandatory webhook lifecycle scenarios succeed, the disabled Global Feed Worker certification passes, and no reservation, ACK, tenant-routing, activation or security invariant is violated.

### PASS WITH OBSERVATIONS

Core lifecycle and disabled-worker safety succeed, but a non-blocking operational observation remains documented with an owner and follow-up.

### FAIL — CERTIFICATION BLOCKED

Any of the following occurs:

- ACK before persistence;
- missing or incorrect property mapping;
- duplicate reservation for the same stable booking ID;
- older revision overwrites newer state;
- unauthenticated webhook is accepted;
- recovery worker loses a durable event;
- one failed event blocks the rest of the recovery batch;
- a rejected cancellation receives ACK;
- another PMS provider is modified by the Channex recovery worker;
- the independent Global Feed Worker starts enabled;
- the independent Global Feed Worker performs a tick while disabled;
- the disabled preflight performs a network call or database query;
- the disabled preflight returns anything other than `READY_DISABLED`;
- a Reference Variable remains unresolved or is stored as literal service-variable text;
- participating runtimes do not resolve to the same physical staging database;
- secrets appear in logs, command output or API responses.

## Production gate

Production remains blocked until:

- this protocol is completed against Channex staging;
- evidence is reviewed;
- focused CI remains green;
- the read-only production schema preflight is completed and reviewed;
- PR #24 is no longer draft;
- merge is explicitly authorized;
- a single independent recovery-worker service is configured for production;
- production webhook registration is designed and separately approved;
- rollback and monitoring procedures are documented.

The independent Global Feed Worker has an additional separate gate. It must remain disabled until:

- a dedicated activation protocol is reviewed;
- explicit authorization is given for a controlled real staging Feed consultation;
- activation scope, polling limits, ACK behavior, rollback and monitoring are approved;
- the controlled staging Feed consultation passes;
- production activation receives a separate explicit authorization.

Completion of the webhook booking lifecycle certification does not authorize enabling the independent Global Feed Worker.
