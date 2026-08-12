# Pin&Go Connect — Controlled Channex Global Feed Staging Certification

## Purpose

Define the controlled protocol required to consult and certify the independent Channex Global Feed in the isolated Railway staging environment.

This protocol does not authorize:

- production access or deployment;
- merge of PR #24;
- production migration changes;
- production Channex credentials or properties;
- permanent activation of the Global Feed Worker;
- more than one Global Feed execution;
- changes to the certified global webhook lifecycle.

## Architectural boundary

The canonical Channex booking lifecycle remains:

```text
POST /webhooks/channex
→ tenant resolution from channexPropertyId
→ durable WebhookEventIngest
→ PMS webhook recovery worker
→ Booking Revision recovery
→ Reservation persistence
→ ACK
```

That lifecycle is already certified for new booking, modification, cancellation and automatic recovery.

The independent Global Feed Worker is a separate recovery runtime. Its controlled staging certification must not redesign or replace the canonical webhook lifecycle.

## Required starting state before execution

Required starting state:

```text
Railway environment: staging-channex-certification
Service: pin-go-channex-global-feed-staging
Runtime role: GLOBAL_FEED_WORKER
CHANNEX_GLOBAL_FEED_ENABLED=false
Replica count: 1
Worker status: Online
Idle log: present
Tick completed: absent
Tick failed: absent
Real Global Feed consultation: not yet performed
```

The API, webhook recovery worker and Global Feed Worker must use the same branch, commit and physical staging database.

## Why permanent activation is not used for the first consultation

When the normal worker starts with activation enabled, it performs a Feed tick immediately and then schedules recurring ticks using `CHANNEX_GLOBAL_FEED_POLL_MS`.

A manual Railway variable change therefore does not provide a strong one-run guarantee.

The first controlled staging consultation must use a dedicated one-shot command that:

1. validates staging identity and explicit confirmation;
2. invokes the existing `runChannexGlobalFeedOnce` service exactly once;
3. waits for completion;
4. prints sanitized evidence;
5. disconnects and exits;
6. never starts a polling interval.

The long-running worker must remain deployed with:

```text
CHANNEX_GLOBAL_FEED_ENABLED=false
```

throughout the one-shot certification.

## Required one-shot runner contract

Implement one dedicated script and package command before any real Feed consultation.

Proposed file:

```text
src/scripts/run-channex-global-feed-staging-once.ts
```

Proposed command:

```text
npm run channex:staging:run-global-feed-once
```

The runner must fail closed unless all conditions pass:

```text
NODE_ENV=staging
PIN_GO_RUNTIME_ROLE=GLOBAL_FEED_WORKER
CHANNEX_API_BASE_URL=https://staging.channex.io
CHANNEX_GLOBAL_FEED_ENABLED=false
CHANNEX_GLOBAL_FEED_STAGING_ONE_SHOT_CONFIRMATION=RUN_CHANNEX_STAGING_GLOBAL_FEED_ONCE
Railway environment=staging-channex-certification
Railway service=pin-go-channex-global-feed-staging
```

It must use the following fixed certification limits instead of permissive runtime defaults:

```text
leaseMs=600000
maxSourcesPerRun=1
maxRevisionsPerRun=1
```

`pollMs` is not operationally used by a one-shot execution and must not create an interval.

The runner must not print:

- API keys;
- database URLs;
- encrypted credentials;
- webhook secrets;
- guest names, email addresses or phone numbers;
- raw reservation payloads;
- payment data.

## Pre-execution gates

All gates must pass before authorizing the one-shot command:

1. Draft PR #24 remains open and unmerged.
2. Focused GitHub Actions are green at the intended head.
3. Global Feed Worker is Online and disabled.
4. Exactly one Global Feed Worker replica exists.
5. No `tick completed` or `tick failed` log exists while disabled.
6. API and workers use the intended branch and current commit.
7. All runtimes use the same physical staging PostgreSQL database.
8. Channex host is exactly `https://staging.channex.io`.
9. The staging database contains no production organization, property or guest data.
10. A sanitized read-only database check confirms the expected active Channex connection and mapping topology.
11. Credential-source cardinality for the first run is exactly one.
12. The webhook recovery worker can be intentionally paused for the controlled missed-webhook scenario.
13. A rollback operator is ready to leave the long-running Global Feed Worker disabled and restore the recovery worker.

Any failed gate blocks the Feed consultation.

## Controlled certification scenario

The first active certification represents recovery of one booking revision while normal webhook execution is temporarily unavailable.

### Phase A — Establish controlled missed-webhook conditions

1. Confirm Global Feed Worker remains disabled.
2. Pause the single staging PMS webhook recovery worker.
3. Keep the API staging service Online so the global webhook can durably store the event.
4. Create exactly one new booking in Channex staging for the certified staging property.
5. Confirm the API received the webhook and stored one PENDING `WebhookEventIngest`.
6. Confirm no Pin&Go reservation has yet been created for the new Channex booking.

Because the registered Channex webhook uses `send_data=false`, the durable event is a property-scoped recovery signal. The paused recovery worker must not process it before the Global Feed one-shot run.

### Phase B — Execute exactly one Global Feed run

Run the dedicated one-shot command from a trusted Railway console attached to:

```text
pin-go-channex-global-feed-staging
```

The command must execute once and exit. It must not change `CHANNEX_GLOBAL_FEED_ENABLED`.

Expected sanitized result:

```text
status=COMPLETED
connectionCount>=1
credentialSourceCount=1
discoveredRevisionCount>=1
selectedRevisionCount=1
acknowledgedRevisionCount=1
failedRevisionCount=0
failedSourceCount=0
```

If the selected revision is not the controlled staging booking revision, stop certification and do not run a second time.

### Phase C — Verify persistence before ACK

Retain sanitized evidence proving:

1. exactly one Pin&Go reservation exists for the controlled Channex booking ID;
2. the reservation belongs to the expected staging organization and property;
3. the reservation external provider is `CHANNEX`;
4. persistence audit completed before acknowledgement audit;
5. ACK completed for the exact Channex revision;
6. no duplicate reservation was created;
7. no unrelated reservation was modified;
8. Mission Control reflects the completed Distribution lifecycle.

### Phase D — Restore webhook recovery

1. Restore the single PMS webhook recovery worker.
2. Confirm it processes the previously stored property-scoped webhook event idempotently.
3. Confirm the recovered event does not create a duplicate reservation.
4. Confirm the Channex Feed is empty for the already acknowledged revision.
5. Confirm no Global Feed polling interval is running.
6. Confirm the long-running Global Feed Worker still logs disabled/idle behavior after any redeployment.

## Success criteria

The controlled staging Global Feed certification passes only when all are true:

```text
one-shot execution count=1
credential source count=1
logical revision processing limit=1
controlled revision persisted=1
controlled revision acknowledged=1
failed revisions=0
failed sources=0
duplicate reservations=0
unrelated reservation mutations=0
persistence before ACK=PASS
webhook recovery restoration=PASS
Global Feed long-running activation=false
production changes=0
```

## Stop conditions

Stop immediately if:

- any service points to production;
- `CHANNEX_API_BASE_URL` differs from `https://staging.channex.io`;
- the Global Feed Worker has more than one replica;
- the long-running worker is enabled;
- credential-source count is not exactly one;
- the one-shot confirmation value is missing or incorrect;
- more than one controlled revision is selected;
- an unrelated revision is selected;
- target resolution is unmapped or ambiguous;
- persistence fails;
- ACK occurs without confirmed persistence;
- any secret or guest PII appears in output;
- any production data appears in staging;
- the recovery worker processes the event before the one-shot run;
- a second one-shot execution would be required.

A failed run must not be retried automatically. Review the sanitized evidence first.

## Rollback and containment

The containment state is always:

```text
CHANNEX_GLOBAL_FEED_ENABLED=false
```

If certification fails:

1. do not execute the one-shot command again;
2. keep the long-running Global Feed Worker disabled;
3. restore the PMS webhook recovery worker;
4. allow the canonical webhook recovery path to reconcile the controlled staging event;
5. verify no duplicate reservation or unsafe access state exists;
6. document the failure before any code or configuration change.

No rollback step may delete production or staging reservation evidence, alter Channex production data, or hide a failed audit trail.

## Evidence to retain

Retain only sanitized evidence:

- branch and commit SHA;
- Railway project, environment and service names;
- runtime roles and replica counts;
- disabled Global Feed Worker logs before and after the run;
- one-shot runner preflight result;
- controlled Channex booking and revision IDs;
- Pin&Go reservation number;
- `WebhookEventIngest` state and attempts;
- persistence and acknowledgement audit timestamps/statuses;
- one-shot summary counts;
- Mission Control lifecycle result;
- recovery-worker restoration result;
- confirmation that production remained unchanged.

## Executed certification evidence — 2026-07-27

### Runtime and code identity

```text
Repository: freddiefernandezmaysonet-netizen/pin-go-backend
Branch: recovery/distribution-engine-v2-channex-lifecycle
Execution commit: 354b9516e13e3955e4bb38c871672547e4129494
PR: #24
PR state during execution: open, Draft, unmerged
Railway environment: staging-channex-certification
Global Feed service: pin-go-channex-global-feed-staging
Runtime role: GLOBAL_FEED_WORKER
Long-running activation: false
Channex host: https://staging.channex.io
```

Focused GitHub Actions passed at the execution commit:

```text
Channex Booking Lifecycle Certification: PASS
Railway Staging Config Certification: PASS
```

The deployed Global Feed Worker matched the intended execution commit, remained Online and logged disabled/idle behavior with no recurring tick completion or failure.

### Pre-execution topology

A sanitized read-only database check returned:

```text
DATABASE_QUERY=PASS
ACTIVE_CHANNEX_CONNECTIONS=1
CREDENTIAL_SOURCE_COUNT=1
MAPPED_LISTINGS=1
INCOMPLETE_MAPPINGS=0
```

The recovery worker was paused while the API and disabled Global Feed Worker remained Online.

### Phase A result — controlled missed webhook

Controlled Channex booking reference:

```text
PINGO-GLOBAL-FEED-CERT-20260727-001
```

Channex UI Reservation ID displayed during booking creation:

```text
ABB- PINGO-GLOBAL-FEED-CERT-20260727-001
```

Before the one-shot run:

```text
PENDING_EVENT_COUNT=1
LATEST_PENDING_EVENT_STATUS=PENDING
LATEST_PENDING_EVENT_ATTEMPTS=0
LATEST_PENDING_EVENT_PROPERTY_ID=1d699e11-593c-4a3d-b66a-28741759e82f
LATEST_PENDING_EVENT_CREATED_AT=2026-07-27T23:26:48.068Z
MATCHING_RESERVATIONS_BEFORE_ONE_SHOT=0
```

Result: **PASS**. The webhook was durably stored, the recovery worker had not claimed it, and no Pin&Go reservation existed for the controlled booking.

### Phase B result — one-shot Global Feed execution

The dedicated command was executed exactly once with the explicit staging confirmation. Sanitized result:

```text
provider=PIN_GO_CONNECT
executionMode=STAGING_GLOBAL_FEED_ONE_SHOT
status=PASS
runStatus=COMPLETED
leaseMs=600000
maxSourcesPerRun=1
maxRevisionsPerRun=1
connectionCount=1
credentialSourceCount=1
discoveredRevisionCount=1
selectedRevisionCount=1
truncatedRevisionCount=0
acknowledgedRevisionCount=1
failedRevisionCount=0
failedSourceCount=0
duplicateRevisionCount=0
emptyFeed=false
longRunningWorkerActivationChanged=false
```

The run created Pin&Go reservation `PG-2026-000002` and exited without creating a polling interval.

Non-blocking staging-data observation:

```text
GUEST_AGREEMENT_SNAPSHOT_MISSING
reason=ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND
```

This did not produce an ingest error, did not affect persistence or ACK ordering, and is not classified as a Global Feed lifecycle failure. It remains a separate staging Guest Journey/property-configuration observation.

### Phase C result — persistence before ACK

Controlled identities:

```text
Pin&Go reservation number: PG-2026-000002
Channex booking ID: ca9d4ac3-881c-4205-92ec-866fec3c427c
Channex revision ID: 17096d6b-8c67-4b76-8517-674a830427bf
Pin&Go property ID: cms0zipff0002pf6n5h3d500k
Channex property ID: 1d699e11-593c-4a3d-b66a-28741759e82f
```

Sanitized persistence evidence:

```text
CONTROLLED_REFERENCE_MATCH=true
EXPECTED_PROPERTY_MATCH=true
EXPECTED_ORGANIZATION_MATCH=true
CHANNEX_PROPERTY_MATCH=true
EXTERNAL_PROVIDER=CHANNEX
EXACT_EXTERNAL_ID_RESERVATION_COUNT=1
PERSISTENCE_AUDIT_STATUS=SUCCESS
ACK_AUDIT_STATUS=SUCCESS
PERSISTENCE_BEFORE_ACK=true
PERSISTENCE_COMPLETED_AT=2026-07-27T23:41:06.369Z
ACK_STARTED_AT=2026-07-27T23:41:06.377Z
ACK_COMPLETED_AT=2026-07-27T23:41:06.649Z
UNRELATED_RESERVATIONS_MUTATED_SINCE_RUN=0
```

Persistence completed 8 milliseconds before acknowledgement started.

Result: **PASS**. Exactly one reservation exists for the controlled external identity, the expected staging tenant and property were resolved, persistence completed before ACK, and no unrelated reservation was mutated.

### Phase D result — canonical recovery restoration and idempotence

The single PMS webhook recovery worker was restored. It claimed and reconciled the original property-scoped event through the canonical webhook recovery path:

```text
EVENT_STATUS=PROCESSED
EVENT_ATTEMPTS=1
EVENT_LAST_ERROR=NONE
EVENT_PROCESSED_AT=2026-07-27T23:48:45.465Z
RESERVATION_COUNT=1
RESERVATION_NUMBER=PG-2026-000002
RESERVATION_LAST_INGEST_ERROR=NONE
PERSISTENCE_AUDIT_COUNT=1
ACK_AUDIT_COUNT=1
```

Result: **PASS**. Recovery did not create a duplicate reservation or duplicate lifecycle audits.

### Mission Control result

The existing Mission Control Distribution read model returned:

```text
MISSION_CONTROL_QUERY=PASS
PROVIDER=PIN_GO_CONNECT
CONNECTED=true
CONNECTION_STATUS=ACTIVE
REVISION_FOUND=true
PERSISTENCE_STATUS=PERSISTED
ACKNOWLEDGEMENT_STATUS=SENT
NEXT_AUTOMATIC_ACTION=NONE
REVISION_RECOVERABLE=false
REVISION_HOST_ACTION_REQUIRED=false
SUMMARY_PENDING_REVISIONS=0
AUTOMATIC_RECOVERY_ACTIVE=false
ACTION_REQUIRED_ACTIVE=false
```

Result: **PASS**. Mission Control projects the controlled revision as terminal and healthy with no automatic recovery or host action pending.

### Final read-only Feed verification

A separate read-only Feed GET was performed after restoration. It did not execute the one-shot service and did not send an ACK:

```text
CHANNEX_FEED_READ=PASS
FEED_REVISION_COUNT=0
TARGET_REVISION_PRESENT=false
TARGET_BOOKING_PRESENT=false
TARGET_PROPERTY_REVISION_COUNT=0
ACK_REQUEST_PERFORMED=false
GLOBAL_FEED_ENABLED=false
```

Result: **PASS**. The acknowledged controlled revision is absent from the Feed and no unrelated pending revision exists for the staging source.

### Post-execution containment

After all verification:

```text
Recovery worker: restored and Online
Global Feed long-running worker: Online and disabled
CHANNEX_GLOBAL_FEED_ENABLED=false
Disabled/idle log: present
Tick completed: absent
Tick failed: absent
Second one-shot execution: not performed
Production changes: 0
```

### Final certification result

```text
one-shot execution count=1: PASS
credential source count=1: PASS
logical revision processing limit=1: PASS
controlled revision persisted=1: PASS
controlled revision acknowledged=1: PASS
failed revisions=0: PASS
failed sources=0: PASS
duplicate reservations=0: PASS
unrelated reservation mutations=0: PASS
persistence before ACK: PASS
canonical webhook recovery restoration: PASS
idempotent recovery: PASS
Mission Control lifecycle projection: PASS
acknowledged revision absent from Feed: PASS
Global Feed long-running activation=false: PASS
production changes=0: PASS
```

**Controlled Channex Global Feed staging certification: PASS.**

This result certifies the isolated one-shot recovery capability in staging. It does not authorize recurring Global Feed polling, production activation, PR merge, production migration reconciliation or production deployment.

## Production boundary

Passing this staging protocol does not automatically authorize permanent Global Feed activation in production.

After this protocol passes, production still requires:

1. reviewed staging evidence;
2. PR approval and explicit merge authorization;
3. approved production rollout and rollback plan;
4. production migration-history reconciliation under separate authorization;
5. production deployment certification;
6. a separate decision on whether the independent Global Feed Worker should remain disabled or receive a controlled production activation plan.
