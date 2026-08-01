# Pin&Go APMS — Distribution Engine: Channex Outbound ARI Certification V1

## Sprint identity

```text
Capability: Pin&Go → Channex outbound ARI synchronization
Engine: Distribution
Methodology: Blueprint → Audit → Implementation → Build → Certification → Production
Branch: sprint/distribution-engine-channex-outbound-ari-v1
Stacked base: recovery/distribution-engine-v2-channex-lifecycle
Certified dependency head: b6755c0da87f5a1578ce30929a3379d36470c26a
```

This sprint is separate from the already certified Channex booking lifecycle.

The prior certification proves:

```text
Channex → Pin&Go
booking creation
booking modification
booking cancellation
Booking Revision Feed recovery
persistence before ACK
idempotent webhook recovery
Mission Control lifecycle projection
```

This sprint must prove the opposite direction:

```text
Pin&Go → Channex
Availability
Rates
Restrictions
full synchronization
incremental synchronization
retries and recovery
rate-limit compliance
durable evidence
```

## Objective

Build and certify an enterprise outbound ARI lifecycle in which Pin&Go remains the source of truth for property inventory, nightly prices and supported restrictions, while Channex receives timely, batched, recoverable and auditable updates.

The completed capability must move Pin&Go closer to autonomous operation:

```text
Pin&Go state changes
→ Distribution Engine detects the affected dates
→ durable outbound intent
→ deterministic coalescing
→ rate-limited Channex delivery
→ task evidence
→ automatic retry or terminal escalation
→ Mission Control observability
```

No host should need to manually repeat normal synchronization after a temporary Channex, network or worker failure.

## Official Channex certification contract

Primary documentation:

```text
https://docs.channex.io/api-v.1-documentation/pms-certification-tests
https://docs.channex.io/guides/pms-integration-guide
https://docs.channex.io/guides/best-practices-guide
https://docs.channex.io/api-v.1-documentation/rate-limits
https://docs.channex.io/api-v.1-documentation/ari
```

The V1 implementation and certification must honor these requirements.

### Full Sync

A certification Full Sync must send 500 days of inventory using exactly two outbound ARI messages for the mapped property:

```text
1 Availability request containing all mapped room inventory
1 Rates & Restrictions request containing all mapped rate-plan values
```

The dataset must contain realistic variation. It must not be a synthetic window where every date has identical availability and price.

Full Sync is a recovery and go-live operation. It must not be the normal response to every change.

### Incremental updates

Normal operation must send only affected changes after Pin&Go state changes.

Required behavior:

```text
single-date change → small delta
multiple related changes → one consolidated batch
reservation or cancellation → prompt availability delta
price change → prompt rates delta
minimum/maximum-stay change → prompt restrictions delta
```

When several changes occur close together, Pin&Go should consolidate them per property for approximately 30–60 seconds instead of sending many small requests.

### Endpoint separation

Availability and Rates & Restrictions must be sent separately.

```text
/api/v1/availability
/api/v1/restrictions
```

Availability receives priority in Channex processing and must not depend on a successful rates message.

### Rate limits

The worker must remain within Channex property-level limits:

```text
Availability: 10 requests per minute per property
Rates & Restrictions: 10 requests per minute per property
Total ARI: 20 requests per minute per property
```

The design must include queueing, batching, throttling and exponential backoff.

A `429 Too Many Requests`, network error or recoverable server response must pause delivery for the affected property and retry without losing the outbound intent.

### Task evidence

Successful Channex responses provide task identifiers used in certification evidence.

Pin&Go must persist sanitized evidence for every outbound batch:

```text
property identity
message kind
covered date range
payload hash
attempt count
Channex task ID
HTTP status
queued/sent/failed/dead timestamps
last public error code
```

Secrets, guest PII and raw database URLs must never appear in certification output or worker logs.

### Update logic

A repeating full-window sync every few minutes or hours is not acceptable as normal update logic.

Permitted pattern:

```text
incremental deltas continuously
optional Full Sync no more than approximately once per 24 hours
Full Sync scheduled off peak
property executions spaced when many properties require recovery
```

## Explicit V1 product capability scope

Pin&Go begins as a vacation-rental APMS. V1 certification will use one physical unit and one primary rate plan per Pin&Go property unless the audited mapping model is expanded deliberately.

Supported outbound V1 fields:

```text
Room Type availability
nightly rate
min_stay_arrival
min_stay_through
max_stay
```

Capabilities not to be represented falsely:

```text
multiple physical units per Pin&Go property
multiple independent rate plans per property
stop_sell
closed_to_arrival
closed_to_departure
```

If these capabilities are not implemented during this sprint, they must be declared as unsupported in the Channex certification file, as allowed by the certification process.

The outbound architecture must nevertheless allow these fields and mapping cardinalities to be added later without replacing the durable lifecycle.

## Audit — current implementation

### Existing service

Current file:

```text
src/services/channex-availability-sync.service.ts
```

Confirmed useful behavior:

- resolves the Pin&Go property and Channex connection;
- resolves property, room-type and rate-plan mappings;
- calculates unavailable dates from ACTIVE reservations and blocked dates;
- uses the Direct Booking pricing engine for nightly prices;
- sends Rates & Restrictions and Availability through separate endpoints;
- includes minimum-stay values;
- returns Channex responses and HTTP statuses to the immediate caller.

### Existing worker

Current file:

```text
src/workers/dynamic-pricing-sync.worker.ts
```

Confirmed useful behavior:

- periodically selects distribution-enabled properties;
- invokes the current Channex synchronization service;
- records Distribution audit evidence;
- records a property-level synchronization error.

### Confirmed blockers for official outbound certification

#### 1. Incorrect Full Sync window

Current default window:

```text
365 days
```

Certification requires:

```text
500 days
```

#### 2. Full-window timer used as normal update logic

The worker currently performs the complete window approximately every six hours.

This violates the required update model because normal operation must send changed values rather than repeat a full synchronization on a timer.

#### 3. No durable outbound outbox

The service calculates and sends in one process. There is no durable record representing an unsent or partially sent ARI intent before the network call.

A worker crash, API restart or process termination can therefore lose the reason for the outbound update.

#### 4. No property-scoped rate limiter

There is no proven limiter that separately enforces:

```text
10 Availability requests/minute/property
10 Restrictions requests/minute/property
```

#### 5. No retry lifecycle or exponential backoff

The current direct `axios` calls throw errors, but the outbound message does not have a durable lease, retry schedule, exhaustion state or dead-letter state.

#### 6. No deterministic change coalescing

Several updates made close together are not represented as mergeable outbound intents with a fixed coalescing window.

#### 7. No persisted Channex task IDs

The immediate response is returned, but task IDs and payload hashes are not preserved in a dedicated durable delivery record suitable for certification and incident recovery.

#### 8. Provisioning mixed with operational ARI

The current ARI service updates the Channex Room Type before every inventory synchronization.

Room Type provisioning and content synchronization must be separate from operational Availability, Rates and Restrictions delivery.

#### 9. Rates payload contains availability-like fields

The current Restrictions payload includes availability-related values while Availability is also sent to its dedicated endpoint.

The payload contracts must be separated strictly by endpoint.

#### 10. Restrictions incomplete

Current payload includes rate and minimum stay but not the full set of supported V1 restrictions. `maximumNights` is present in the Pin&Go property model but is not sent as `max_stay`.

#### 11. No dedicated outbound certification suite

The existing `test:channex-certification` suite certifies bookings, webhook security, Global Feed and recovery. It does not certify the outbound ARI service, batching, rate limiting, retries, Full Sync shape or task evidence.

#### 12. Sensitive runtime logging

The current dynamic-pricing worker prints the raw `DATABASE_URL` value during startup.

This is prohibited and must be removed before the runtime is certified.

#### 13. Success audit semantics are too broad

The existing worker labels the operation mainly as `AVAILABILITY`, even though the service also changes Room Type data, prices and restrictions.

Audit and Mission Control must represent each outbound message and its actual lifecycle, not a single coarse daily result.

## Target architecture

### Canonical outbound lifecycle

```text
Pin&Go domain mutation
→ determine affected property/date range/message kinds
→ upsert durable Distribution Outbox intent
→ coalesce pending intents by property for 30–60 seconds
→ build canonical Availability batch
→ build canonical Rates & Restrictions batch
→ acquire property/message-kind lease
→ enforce property rate limit
→ send one Channex request
→ persist task ID and response evidence
→ mark delivery SENT
→ retry recoverable failures with exponential backoff
→ mark terminal exhaustion when policy is exceeded
→ project state into Mission Control
```

### Proposed durable concepts

Names remain provisional until the schema audit is complete.

```text
DistributionOutboxEvent
ChannexAriDelivery
ChannexAriDeliveryAttempt
```

Required lifecycle states:

```text
PENDING
COALESCING
READY
PROCESSING
RETRY_WAIT
SENT
FAILED
DEAD
SUPERSEDED
```

### Message kinds

```text
AVAILABILITY
RATES_RESTRICTIONS
FULL_SYNC_AVAILABILITY
FULL_SYNC_RATES_RESTRICTIONS
```

### Change sources

The audit must identify and wire the smallest safe producer boundary for:

```text
reservation created
reservation dates changed
reservation cancelled
blocked date created/updated/deleted
nightly rate created/updated/deleted
base price changed
dynamic-pricing configuration changed
season or holiday pricing changed
minimum nights changed
maximum nights changed
distribution enabled or mapping completed
manual recovery Full Sync requested
```

Domain transactions must not wait for Channex. They must persist the local state first and create a durable outbound intent.

### Coalescing policy

For the same property and message kind:

```text
overlapping date ranges merge
adjacent date ranges may merge
newer values supersede older unsent values
one batch covers all pending changes ready at dispatch time
```

Coalescing must preserve the latest canonical Pin&Go state rather than replay stale deltas blindly.

### Retry policy

Initial policy to validate during implementation:

```text
429/network/timeout/5xx → recoverable
400/401/403/mapping contract errors → terminal or host/developer action
property pause after recoverable failure → at least 60 seconds
backoff → exponential with bounded jitter
lease recovery → stale PROCESSING deliveries return to retry
maximum attempts → explicit terminal DEAD state
```

No automated retry may exceed Channex rate limits.

### Full Sync policy

Full Sync is a separate operation, not the normal worker loop.

```text
window=500 days
messages=2
availability message=1
rates/restrictions message=1
explicit trigger or controlled daily recovery schedule
per-property 24-hour guard unless manual override is separately authorized
```

Full Sync must use the same durable delivery and evidence lifecycle as incremental changes.

### Mission Control

Mission Control must display only states that require observation or intervention.

Healthy terminal deliveries should contribute to summary/history but not create host work.

Required observable states:

```text
pending/coalescing
retry scheduled
rate limited
mapping or authentication failure
recovery exhausted
last successful Availability task
last successful Rates & Restrictions task
current outbound lag
```

The Distribution Engine must attempt automatic recovery before surfacing host action.

## Certification matrix

### Unit and contract tests

- canonical Availability payload;
- canonical Rates & Restrictions payload;
- 500-day Full Sync boundaries;
- exactly two Full Sync messages;
- endpoint separation;
- realistic variable data preservation;
- one-room/one-rate mapping contract;
- supported restriction fields;
- unsupported capability declarations;
- payload size guard;
- coalescing overlapping and adjacent ranges;
- latest-state supersession;
- per-property/message-kind throttling;
- `429` retry and property pause;
- timeout and `5xx` retry;
- terminal authentication/mapping errors;
- stale lease recovery;
- max-attempt exhaustion;
- task ID persistence;
- no secrets or raw database URLs in output;
- Mission Control projection.

### Staging certification scenarios

1. Full Sync: 500 days, exactly two task IDs.
2. Single-date single-rate update from Pin&Go.
3. Multiple-rate case: declare unsupported or execute if mapping support is added.
4. Multiple-date update consolidated into one Restrictions call.
5. Minimum-stay update.
6. Stop Sell: declare unsupported unless implemented.
7. CTA/CTD: declare unsupported unless implemented.
8. Half-year rates/restrictions update in one call.
9. Reservation-driven single-date Availability update.
10. Multiple-date Availability update in one call.
11. Existing inbound booking certification reference.
12. Rate-limit compliance and queue evidence.
13. Change-only update logic evidence.
14. Live screenshare readiness and certification form task IDs.

### Failure injection

- worker terminates after outbox creation but before delivery;
- worker terminates after Channex response but before local SENT update;
- duplicate worker replicas contend for the same delivery;
- Channex returns `429`;
- Channex times out;
- Channex returns `500`;
- invalid mapping;
- missing rate plan;
- stale delivery lease;
- superseded pending date range;
- Full Sync requested while recent Full Sync guard is active.

## Implementation order

No implementation begins until this Blueprint and the remaining schema/producer audit are reviewed.

One capability and one file at a time:

1. Finish exact route, producer and schema audit.
2. Freeze canonical payload and lifecycle policies in tests.
3. Add durable schema and migration.
4. Implement outbox creation service.
5. Implement deterministic coalescing.
6. Implement Channex ARI adapter with strict endpoint contracts.
7. Implement worker lease, limiter, retries and task evidence.
8. Wire one producer at a time.
9. Replace the six-hour Full Sync behavior.
10. Add Mission Control read model.
11. Build focused CI suite.
12. Deploy disabled/controlled staging runtime.
13. Execute official staging scenarios.
14. Record evidence and prepare Channex live demonstration.

## Branch and PR strategy

This sprint is stacked on the certified inbound lifecycle branch so its diff can remain isolated.

Proposed Draft PR:

```text
head: sprint/distribution-engine-channex-outbound-ari-v1
base: recovery/distribution-engine-v2-channex-lifecycle
```

The outbound PR must not be retargeted to `main`, merged or deployed to production until PR #24 and the production migration-history baseline are handled under their own authorizations.

## Safety boundaries

This Blueprint does not authorize:

- production changes;
- production Channex calls;
- merge of PR #24;
- merge of the outbound ARI PR;
- deployment of a new worker;
- execution of Full Sync in staging;
- incremental staging writes to Channex;
- schema migration in production;
- permanent Global Feed activation;
- unrelated refactors.

All real outbound Channex staging calls require a separately reviewed execution protocol and explicit authorization after code, tests and topology checks pass.

## Blueprint status

```text
Official Channex requirements reviewed: PASS
Current outbound implementation audited at service/worker level: PASS
Critical certification gaps identified: PASS
Target lifecycle defined: PASS
Implementation authorized: NOT YET
Production authorized: NO
```

## Staging Certification Closure — 2026-08-01

### Verdict

```text
Environment: staging-channex-certification
Service: pin-go-channex-ari-dispatch-staging
Certified commit: 49b64b0facd2f29d09d67a9a10beaa98edc6d0bb
Incremental Availability: PASS
Incremental Rates & Restrictions: PASS
Production authorized: NO
PR merge authorized: NO
```

This section supplements the original Blueprint and preserves its audit history, architecture, unsupported capabilities and safety boundaries.

### Certified scope

The controlled staging certification validated the frozen V1 mapping:

```text
1 Pin&Go property
→ 1 Channex property
→ 1 Channex Room Type
→ 1 Channex Rate Plan
```

| Capability | Result |
| --- | --- |
| Single-date Availability | PASS |
| Single-date nightly rate | PASS |
| `min_stay_arrival` | PASS |
| `min_stay_through` | PASS |
| `max_stay` | PASS |
| Endpoint separation | PASS |
| Durable outbox, delivery and attempt evidence | PASS |
| Worker-disabled controlled execution | PASS |
| Channex Inventory UI verification | PASS |
| Production isolation | PASS |

### Certified mapping

```text
Organization: cms0zipf70000pf6n7is2ncwr
Property: cms0zipff0002pf6n5h3d500k
Connection: cms0zipfl0004pf6n5i0z6oxt
Listing: cms0zipfr0006pf6nu8tzzbr9
Channex property: 1d699e11-593c-4a3d-b66a-28741759e82f
Room Type: 31a7161d-cd47-4f38-b5f4-4b9e11d4e6f9
Rate Plan: daa6211c-bd9b-455f-b526-4136550b9a92
```

### Availability evidence

```text
Date: 2026-08-01
Availability: 1
Outbox: cms994ncl0000mq6u73znfdoi
Delivery: cms99isgf0000mq9llewlwxbk
Payload hash: f0ace7d0bced24091e03da1b1be318a03a6084e518b3af83ff3079e94bff343f
Payload bytes: 158
Successful POST request: GMd8RwYnKAejphMBBoxh
Verification GET request: GMd9UhrHgARqtF4BDGkB
HTTP status: 200
Warnings: 0
lastSuccessfulAvailabilityAt: 2026-07-31T21:13:41.865Z
```

The delivery preserves two attempts. The successful second attempt was reconciled after the earlier task-ID requirement was proven to cause a false terminal classification.

### Rates & Restrictions evidence

```text
Date: 2026-08-01
Outbox: cmsahbbgu0000qi6r9q8uby7x
Delivery: cmsahbbh00001qi6rit97uyvj
Attempt: cmsahmp5e0001qi9cv35km83s
POST request: GMe16SGz3-xC5YgBUith
Payload hash: f8207002046d11820da1031d3095fd94f941f42577f1141ed7463074ed79d740
Payload bytes: 209
HTTP status: 200
Warnings: 0
Attempt outcome: SUCCESS
lastSuccessfulRatesAt: 2026-08-01T14:49:50.298Z
Channex Inventory UI: PASS — user confirmed
```

Certified values:

```json
{
  "date": "2026-08-01",
  "rate": 10000,
  "min_stay_arrival": 1,
  "min_stay_through": 1,
  "max_stay": 0
}
```

### Certified monetary-unit contract

Pin&Go Revenue produces rates in major currency units. Channex Rates & Restrictions requires integer minor units.

```text
100.00 major units × 100 = 10000 minor units
minorUnits = Math.round(majorUnits * 100)
```

The result must be a positive safe integer. Two earlier deliveries using `"100"` and `"100.00"` remain as historical evidence. Both returned HTTP 200 with zero warnings, but only the integer minor-unit payload produced the required effective Inventory UI value.

### Certified response-success policy

A missing task ID does not independently invalidate an exchange that returns:

```text
HTTP status: 2xx
warningCount: 0
```

Certified rule:

```text
2xx + zero warnings → SUCCESS
```

Rejected-value warnings remain authoritative.

### Final closure state

```text
Total ARI deliveries: 4
Availability deliveries: 1
Rates & Restrictions deliveries: 3
Total attempts: 5
Total outbox events: 4
Outbox events MERGED: 4
Unsafe or pending deliveries: 0
Active leases: 0
Pending retries: 0
Worker enabled: NO
baseNightlyRate: null
```

The temporary staging value `baseNightlyRate = 100.00` was removed after certification. All delivery, attempt, outbox, payload-hash and property-success evidence remained preserved.

### Not certified by this closure

```text
500-day Full Sync
exactly two real Full Sync requests
multi-date staging updates
half-year staging updates
rate-limit load testing
live 429, timeout or 5xx injection
duplicate-worker contention
permanent worker activation
production migrations
production deployment
production Channex traffic
```

The following capabilities remain unsupported in V1 unless implemented later:

```text
multiple physical units per property
multiple independent rate plans per property
stop_sell
closed_to_arrival
closed_to_departure
```

### Authorization boundary

This staging PASS does not authorize merging or retargeting PR #26, merging PR #24, executing Full Sync, permanently activating the worker, deploying to production or calling production Channex.

Any such step requires a separate audit, execution protocol and explicit authorization.

### Updated sprint status

```text
Blueprint retained: YES
Incremental Availability staging: PASS
Incremental Rates & Restrictions staging: PASS
Minor-unit rate contract: PASS
Channex Inventory UI verification: PASS
Temporary staging configuration removed: PASS
Final read-only closure audit: PASS
Full Sync staging execution: NOT YET
Permanent worker activation: NOT AUTHORIZED
Production authorized: NO
PR merge authorized: NO
```
