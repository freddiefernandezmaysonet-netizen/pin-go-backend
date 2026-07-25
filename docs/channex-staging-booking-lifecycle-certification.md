# Pin&Go Connect — Channex Staging Booking Lifecycle Certification

## Status

This protocol is for Channex staging only.

It does not authorize:

- merge;
- production deployment;
- production API keys;
- production properties;
- real guest personal data;
- multiple recovery-worker replicas.

## Certification target

Validate the complete lifecycle:

```text
Channex booking event
→ authenticated Pin&Go webhook
→ durable WebhookEventIngest
→ independent recovery worker
→ Booking Revision pull or Feed recovery
→ canonical Reservation persistence
→ Distribution audit
→ Channex revision ACK
→ Mission Control observability
```

## Official behavior represented by this implementation

- The `booking` event covers new, modified and cancelled Booking Revisions.
- The webhook is a trigger; Pin&Go does not treat webhook order as booking order.
- `send_data=false` delivers a minimal trigger containing `event`, `user_id` and `property_id`.
- Pin&Go pulls the specific Booking Revision when a revision ID is available.
- Pin&Go uses the Booking Revision Feed when the webhook contains only the property ID.
- Feed results are processed oldest-first.
- ACK is sent only after Pin&Go has persisted the revision.

## Required staging topology

Use an isolated staging database and two independent services built from PR #24.

### API service

Runs the regular Pin&Go API and exposes:

```text
POST /webhooks/channex
GET /api/dashboard/properties/:id/mission-control
```

### Recovery worker service

Run exactly one replica:

```bash
npm run worker:pms-webhook-recovery
```

Do not mount this command inside the API service or another worker.

### Required shared configuration

Both services must use the same staging database and compatible values for:

```text
DATABASE_URL
PMS_CREDENTIALS_SECRET
CHANNEX_API_BASE_URL=https://staging.channex.io
```

The worker must have access to the Channex staging API key through the existing Pin&Go credential contract.

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
4. The independent worker claims it as `PROCESSING`.
5. Pin&Go pulls the Booking Revision or Feed.
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
- Mission Control reports no host action required.

## Scenario 2 — Booking modification

Modify dates or guest details on the same staging booking.

### PASS criteria

- no second reservation is created;
- the existing reservation is updated;
- `externalUpdatedAt` advances to the modification revision timestamp;
- access dates are reconciled through the canonical ingestion path;
- the modification revision receives ACK only after persistence;
- Mission Control returns the revision as acknowledged.

## Scenario 3 — Booking cancellation before stay start

Cancel the staging booking before check-in.

### PASS criteria

- the existing reservation becomes `CANCELLED`;
- the cancellation is not represented as a new reservation;
- applicable downstream access reconciliation runs through canonical ingestion;
- persistence audit is `SUCCESS`;
- ACK audit is `SUCCESS`;
- webhook event is `PROCESSED`.

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

- Feed processing is oldest-first;
- a revision older than `Reservation.externalUpdatedAt` cannot overwrite current reservation state;
- an already persisted revision can still complete ACK recovery;
- final reservation state matches the newest revision;
- each persisted revision has an independent audit identity.

## Scenario 6 — Duplicate minimal webhook and empty Feed

After all revisions have been acknowledged, send the same authenticated property-only trigger again.

### PASS criteria

- Pin&Go queries the Feed;
- an empty property Feed is treated as an idempotent success;
- event becomes `PROCESSED` with zero revisions;
- the event does not consume all recovery attempts;
- Mission Control does not create a false incident.

## Scenario 7 — API restart before worker processing

1. Stop the recovery worker.
2. Trigger a valid authenticated booking webhook.
3. Confirm the API stores the event as `PENDING`.
4. Restart the API if desired.
5. Start the independent recovery worker.

### PASS criteria

- the stored event survives API restart;
- the worker processes the event without another webhook;
- reservation persistence and ACK complete normally.

## Scenario 8 — Worker interruption during processing

1. Allow the worker to claim an event as `PROCESSING`.
2. Stop the worker before completion.
3. Wait past `PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS`.
4. Restart the worker.

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

## Evidence package

Capture the following for each scenario, redacting secrets and guest PII:

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
- Channex Feed state before and after ACK;
- Mission Control lifecycle summary;
- worker logs for recovery scenarios;
- HTTP status for authentication tests.

Never include:

- API keys;
- webhook secret values;
- encrypted credentials;
- payment card data;
- complete guest contact information.

## Certification decision

### PASS

All mandatory scenarios succeed and no reservation, ACK, tenant-routing or security invariant is violated.

### PASS WITH OBSERVATIONS

Core lifecycle succeeds, but a non-blocking operational observation remains documented with an owner and follow-up.

### FAIL — CERTIFICATION BLOCKED

Any of the following occurs:

- ACK before persistence;
- missing or incorrect property mapping;
- duplicate reservation for the same stable booking ID;
- older revision overwrites newer state;
- unauthenticated webhook is accepted;
- worker loses a durable event;
- one failed event blocks the rest of the batch;
- a rejected cancellation receives ACK;
- secrets appear in logs or API responses;
- another PMS provider is modified by the Channex recovery worker.

## Production gate

Production remains blocked until:

- this protocol is completed against Channex staging;
- evidence is reviewed;
- PR #24 is no longer draft;
- merge is explicitly authorized;
- a single independent recovery-worker service is configured;
- production webhook registration is designed and separately approved;
- rollback and monitoring procedures are documented.
