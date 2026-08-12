# Pin&Go APMS — Channex Outbound ARI Producer and Schema Audit V1

## Audit identity

```text
Engine: Distribution
Capability: Pin&Go → Channex Availability, Rates and Restrictions
Branch: sprint/distribution-engine-channex-outbound-ari-v1
Stacked dependency: recovery/distribution-engine-v2-channex-lifecycle
Dependency head: b6755c0da87f5a1578ce30929a3379d36470c26a
Methodology stage: Audit
Code modification authorized: NO
Production authorized: NO
Real outbound staging execution authorized: NO
```

This audit complements:

```text
docs/channex-outbound-ari-certification-v1.md
```

It records the exact durable schema and producer boundaries required before implementation.

## Audit conclusion

The current outbound implementation is functional as a prototype but cannot pass enterprise or official Channex outbound certification in its present form.

Confirmed current behavior:

```text
local mutation
→ direct synchronous full-window calculation
→ Room Type update
→ Rates & Restrictions request
→ Availability request
→ immediate response/audit
```

Required behavior:

```text
local mutation and durable intent in one database transaction
→ asynchronous coalescing
→ canonical ARI snapshot
→ property-scoped throttle
→ independent Availability or Rates & Restrictions delivery
→ durable task and attempt evidence
→ automatic retry or terminal escalation
```

## Schema audit

### Existing reusable models

The existing PMS schema provides:

```text
PmsConnection
PmsListing
WebhookEventIngest
PmsReservationLink
ApmsAuditEntry
OperationalIssue
```

Useful responsibilities:

- `PmsConnection` identifies the organization/provider connection and credential source.
- `PmsListing` maps a Pin&Go property to the Channex Room Type and stores Channex Property/Rate Plan metadata.
- `ApmsAuditEntry` and `OperationalIssue` can expose summarized lifecycle evidence and Mission Control state.

### Existing models that must not be repurposed

`WebhookEventIngest` is an inbound event journal. Its semantics are:

```text
external webhook received
→ pending/processing/retry/dead
→ inbound reservation persistence
```

It must not be overloaded with outbound ARI intent or delivery semantics.

`src/pms/jobs/job.queue.ts` is not a durable generic queue. Channex booking events delegate to the PMS webhook recovery worker; legacy providers can execute through `setImmediate`. It cannot provide ARI durability, batching, rate limiting or crash recovery.

### Missing schema capabilities

No current table can persist:

- the outbound intent inside the same transaction as a Pin&Go mutation;
- exact affected dates or date ranges;
- the distinction between Availability and Rates & Restrictions;
- Full Sync versus incremental delivery;
- coalescing and supersession;
- delivery leases;
- Channex task IDs;
- request payload hashes;
- validation warning counts;
- per-attempt HTTP evidence;
- property-scoped rate-limit state;
- retry scheduling and terminal exhaustion.

A new durable outbound schema is required.

## Producer audit matrix

### 1. Canonical reservation ingest

File:

```text
src/services/ingest.service.ts
```

Used by:

- `/api/ingest/reservations`;
- Channex booking lifecycle persistence;
- modern manual reservations from Calendar V2;
- Direct Booking completion.

Current gap:

- Reservation upsert occurs inside a transaction, but no outbound intent is written.
- Modification logic does not return the previous check-in/check-out/status.
- A date change therefore cannot release the previous nights and occupy the new nights with a precise delta.

Required producer behavior:

```text
new ACTIVE reservation
→ AVAILABILITY for new [checkIn, checkOut)

ACTIVE date modification
→ AVAILABILITY for union(old range, new range)

ACTIVE → CANCELLED
→ AVAILABILITY for old occupied range

CANCELLED → ACTIVE
→ AVAILABILITY for new occupied range
```

The previous state and the new state must be captured before transaction completion.

If the current Revenue policy has occupancy pricing enabled, an ACTIVE reservation create/change/cancel can also change calculated rates. That secondary `RATES_RESTRICTIONS` intent must be produced according to the certified Revenue policy; Distribution must not silently change occupancy-pricing semantics.

The durable intent must be inserted in the same Prisma transaction as the reservation mutation.

### 2. Legacy manual reservation creation

File:

```text
src/services/reservations.service.ts
```

Current behavior:

- creates `Reservation` and `AccessGrant` directly;
- bypasses `ingestReservation`;
- creates no outbound intent.

Required action:

- preserve the current Access behavior;
- insert the same Availability intent in the existing transaction;
- do not perform a synchronous Channex call.

A later lifecycle consolidation may route this legacy path through canonical ingest, but that refactor is not required to establish ARI durability.

### 3. Legacy reservation cancellation blocker

File:

```text
src/services/reservations.patch.service.ts
```

Confirmed defect:

```text
action=CANCEL
→ revokes ACTIVE AccessGrants
→ does not set Reservation.status=CANCELLED
```

If no ACTIVE grant exists, the function returns without modifying the reservation.

Impact:

- Pin&Go continues to treat the nights as occupied;
- outbound Availability cannot release them;
- the route reports cancellation semantics without a canonical cancellation.

This is a direct ARI dependency blocker.

Required correction:

- update `Reservation.status=CANCELLED` and cancellation timestamps/actor in a transaction;
- create the Availability intent for the reservation range in the same transaction;
- preserve current grant-revocation behavior as post-cancellation operational reconciliation;
- do not redesign Access Engine internals.

### 4. Direct Booking completion

Files:

```text
src/webhooks/stripe.webhook.ts
src/services/direct-booking.service.ts
```

Current behavior:

- confirms the booking through `ingestReservation`;
- then calls `syncChannexAvailabilityForProperty` synchronously;
- recalculates the complete 365-day window;
- sends Room Type, Rates & Restrictions and Availability for one new booking;
- couples Stripe webhook completion to Channex network availability.

Required replacement:

```text
reservation transaction
→ durable Availability intent
→ Stripe webhook completes without waiting for Channex
```

The current direct sync block and its property-level success/error update must be removed only after the durable producer and worker are certified.

### 5. Guest cancellation without automatic refund

File:

```text
src/services/guest-cancellation.service.ts
```

Current behavior:

- correctly sets `Reservation.status=CANCELLED`;
- performs operational cancellation reconciliation;
- then executes the complete Channex sync synchronously.

Required replacement:

- cancellation and Availability intent in one transaction;
- operational reconciliation remains after persistence;
- no direct Channex call from the guest request.

### 6. Direct Booking refund cancellation

File:

```text
src/services/direct-booking-refund.service.ts
```

Current behavior:

- Stripe refund occurs first;
- reservation is marked CANCELLED;
- complete Channex sync executes synchronously afterward.

Required replacement:

- after successful Stripe refund, reservation cancellation and Availability intent must be committed together;
- no direct Channex call from the refund request;
- failed Channex delivery must not reverse or hide the successful refund/cancellation.

### 7. Dashboard manual reservation

File:

```text
src/routes/dashboard.properties.route.ts
POST /api/dashboard/properties/:id/manual-reservations
```

Current behavior:

- uses `ingestReservation`;
- then executes a complete Channex sync;
- records the operation as `syncType=AVAILABILITY` even though the service also sends rates/restrictions and updates Room Type.

Required replacement:

- rely on the canonical reservation producer;
- remove route-level synchronous ARI and duplicated Distribution audit blocks;
- return the reservation result without waiting for Channex.

### 8. Property configuration update

File:

```text
src/routes/dashboard.properties.route.ts
PATCH /api/dashboard/properties/:id
```

Current behavior:

- updates pricing, restrictions, distribution and unrelated presentation fields in one route;
- when `distributionStatus=ACTIVE`, executes a complete Channex sync for every update, including photos or description;
- a Channex failure can turn a successful local edit into an HTTP 500 and set the complete distribution state to FAILED.

ARI-impacting fields:

```text
baseNightlyRate
minimumNightlyRate
maximumNightlyRate
dynamicPricingEnabled
weekendMarkupPercent
leadTimePricingEnabled
leadTimeLastMinuteDays
leadTimeLastMinutePercent
occupancyPricingEnabled
occupancy thresholds/adjustments
seasonalPricingEnabled
holidayPricingEnabled
minimumNights
maximumNights
```

Required producer behavior:

```text
actual change to an ARI-impacting field
→ RATES_RESTRICTIONS intent
→ full active 500-day horizon or exact policy-computed date set
```

Non-ARI changes must not create outbound work.

The route must compare previous and new values. A submitted value equal to the existing value must not create an intent.

`distributionEnabled` must not be toggled casually through this generic patch. Initial activation belongs to the dedicated distribution-enablement lifecycle.

### 9. Nightly rate overrides

File:

```text
src/routes/dashboard.properties.route.ts
PUT /api/dashboard/properties/:id/nightly-rates
```

Current behavior:

- upserts each date separately outside a transaction;
- then executes the complete Channex sync;
- audits a rate update as Availability.

Required producer behavior:

- validate all items first;
- persist all rate overrides and one durable `RATES_RESTRICTIONS` intent in one transaction;
- store the exact changed date keys;
- one UI operation must produce one coalescible intent, not one network request per date.

### 10. Market season defaults

Files:

```text
src/services/market-season-template.service.ts
src/routes/dashboard.properties.route.ts
```

Current behavior:

- deactivates, creates and updates rules through separate database operations;
- enables `seasonalPricingEnabled` separately;
- route then executes the complete Channex sync;
- operation is audited as Availability.

Required producer behavior:

- accept a Prisma transaction client;
- apply all changes and one `RATES_RESTRICTIONS` intent atomically;
- use the 500-day active horizon because month/day rules recur across years;
- no direct Channex call from the route.

### 11. Custom season create/update/delete

File:

```text
src/routes/dashboard.properties.route.ts
```

Current behavior:

- creates, updates or soft-deletes `PropertySeason`;
- performs a complete Channex sync after every operation;
- records each operation as Availability.

Required producer behavior:

```text
season mutation + RATES_RESTRICTIONS horizon intent
in one transaction
```

Soft-deletion must recalculate current canonical values; it must not replay stale previous rates.

### 12. Holiday pricing defaults

Files:

```text
src/services/holiday-pricing-template.service.ts
src/routes/dashboard.properties.route.ts
```

Current behavior:

- performs multiple non-transactional rule mutations;
- enables `holidayPricingEnabled` separately;
- the `apply-defaults` route creates no immediate Channex sync or durable intent.

Impact:

Channex can remain stale until the six-hour worker runs.

Required producer behavior:

- all template writes and one `RATES_RESTRICTIONS` 500-day-horizon intent in one transaction.

### 13. Holiday pricing update

File:

```text
src/routes/dashboard.properties.route.ts
PATCH /api/dashboard/properties/:id/holiday-pricing/:holidayPricingId
```

Current behavior:

- updates the rule;
- executes a complete Channex sync;
- audits it as Availability.

Required producer behavior:

- rule update and `RATES_RESTRICTIONS` horizon intent in one transaction;
- no direct network call.

### 14. Blocked-date create/delete

File:

```text
src/routes/dashboard.properties.route.ts
```

Current behavior:

- creates or deletes the block locally;
- retains the exact start/end range;
- then runs the complete Channex sync outside the transaction.

Required producer behavior:

```text
block create/delete + AVAILABILITY exact range intent
in one transaction
```

The end boundary is exclusive internally.

There is no blocked-date update route in the audited router. Future update support must enqueue the union of old and new ranges.

### 15. Distribution enablement

File:

```text
src/routes/dashboard.properties.route.ts
POST /api/dashboard/properties/:id/distribution/enable
```

Current behavior:

```text
set ENABLING
→ provision Property/Room Type/Rate Plan
→ execute monolithic complete sync
→ set ACTIVE
```

Required behavior:

```text
verified provisioning/mapping
→ create exactly two FULL sync intents
   FULL AVAILABILITY, 500 days
   FULL RATES_RESTRICTIONS, 500 days
→ process through the normal durable delivery lifecycle
→ mark ACTIVE only according to the approved activation policy
```

The two deliveries must share a certification/full-sync correlation ID.

### 16. Manual sync endpoint

File:

```text
src/routes/dashboard.properties.route.ts
POST /api/dashboard/properties/:id/channex/sync-availability
```

Current name is misleading: it invokes the monolithic Room Type + Rates + Availability service.

Required replacement:

- become an explicit controlled recovery request;
- create durable Full Sync intents subject to the 24-hour guard;
- require authorization and tenant ownership;
- never execute Channex directly inside the HTTP request.

### 17. Property archive

File:

```text
src/routes/properties.route.ts
POST /api/properties/:id/archive
```

Current behavior:

- blocks archive when ACTIVE reservations exist;
- archives locally;
- does not deactivate or close inventory in Channex.

Required policy decision:

A distributed property cannot be silently archived while its Channex mapping remains sellable.

V1 options:

1. reject archive until distribution is explicitly disconnected through a controlled lifecycle; or
2. implement a supported close/disconnect operation before archive.

Because V1 currently declares `stop_sell` unsupported, option 1 is the safer certification boundary.

### 18. Scheduled pricing changes

Current pricing includes lead-time and occupancy rules.

Lead-time pricing changes as calendar time advances even without a user mutation.

Required scheduled producers:

```text
daily horizon extension
→ AVAILABILITY for the newly added 500th date
→ RATES_RESTRICTIONS for the newly added 500th date

daily lead-time transition
→ RATES_RESTRICTIONS for exact dates crossing a configured threshold
```

This scheduled producer replaces the need to run a complete 365-day sync every six hours.

Occupancy-pricing intents are triggered by reservation changes according to the certified Revenue policy.

### 19. Current six-hour worker

File:

```text
src/workers/dynamic-pricing-sync.worker.ts
```

Current behavior:

- every approximately six hours;
- selects distribution-enabled properties;
- sends complete Room Type, Rates and Availability windows;
- has no durable lease/retry lifecycle;
- logs raw `DATABASE_URL`.

Required action:

- remove raw secret logging immediately during implementation;
- replace full-window polling with the ARI outbox worker and narrow scheduled producers;
- retain no recurring monolithic Full Sync loop.

## Mapping and provisioning audit

### Mapping route blocker

File:

```text
src/pms/routes/listings.mapping.routes.ts
```

Confirmed defects:

- no `requireAuth` or `requireOrg` middleware;
- arbitrary `pmsListingId` can be assigned to arbitrary `propertyId`;
- no organization ownership verification;
- no provider verification;
- no validation of `channexPropertyId` or `channexRatePlanId` metadata;
- no V1 one-listing-per-property constraint;
- `dev-create` is mounted through the normal router and is not environment-gated.

Required correction before ARI delivery:

- authenticate every mutation;
- derive organization from authenticated context;
- verify connection and property share that organization;
- require `provider=CHANNEX` for Channex ARI mappings;
- validate Property, Room Type and Rate Plan IDs;
- disable development creation outside non-production environments;
- enforce V1 mapping cardinality.

Recommended schema constraint:

```text
PmsListing @@unique([connectionId, propertyId])
```

Because `propertyId` is nullable, PostgreSQL can continue to hold multiple unmapped listings while enforcing a single mapped listing per connection/property.

### Provisioning separation

File:

```text
src/services/channex-provisioning.service.ts
```

Confirmed useful behavior:

- creates Channex Property, Room Type and Rate Plan;
- persists remote IDs in `PmsListing` metadata.

Confirmed risks:

- remote objects are created before local mapping persistence;
- a mid-sequence failure can leave orphaned remote resources;
- retry can create duplicates;
- any existing listing causes `alreadyProvisioned=true` without validating metadata completeness;
- a `ratePlanPayload` containing `min_stay` is constructed but not used by the actual Rate Plan request.

Provisioning remains separate from operational ARI.

The first Full Sync must be blocked until a verified mapping exists. ARI delivery must never update Room Type content as a side effect.

## Credential contract audit

Current connection surfaces are inconsistent:

- `org.pms.routes.ts` accepts and encrypts organization-specific Channex API keys;
- current provisioning and current ARI sync resolve only `CHANNEX_API_KEY` from the environment;
- the certified Channex adapter supports encrypted connection credentials with controlled environment fallback;
- Channex connection testing is hard-coded to the staging host.

Outbound ARI must reuse one credential resolver consistent with the certified adapter contract.

It must not introduce another global-only or tenant-only credential path.

## Canonical snapshot audit

### Availability source

File:

```text
src/services/availability.service.ts
```

Canonical business rule for the current one-unit V1:

```text
ACTIVE reservation or PropertyBlockedDate overlaps night
→ availability=0
otherwise
→ availability=1
```

The current Channex sync duplicates this logic. The new ARI snapshot must centralize it.

### Property-local date semantics

Direct Booking stores reservation instants using the property's timezone and check-in/check-out times.

Current availability date-key generation derives `YYYY-MM-DD` from UTC instants. This can shift local calendar dates for some global time zones.

The ARI snapshot must convert reservation instants back into the property's local calendar before deriving Channex date keys.

Internal range contract:

```text
from date: inclusive
to date: exclusive
```

Channex payload conversion may use exact dates or an inclusive `date_to` only at the adapter boundary.

### Rates source

File:

```text
src/services/direct-booking-pricing.service.ts
```

Useful behavior:

- deterministic nightly base/manual override selection;
- seasonal, holiday, occupancy, lead-time and weekend rules;
- min/max price guardrails;
- integer nightly rounding;
- per-date Revenue decision trace.

Not suitable as the ARI adapter input without extraction:

- guest quote concerns include amenities, taxes and checkout totals;
- it creates per-date Revenue audit objects even when only ARI values are needed;
- lead time depends on current time;
- occupancy queries are scoped to the requested stay range, which can make a narrow incremental request use incomplete occupancy context;
- blocked dates are queried for occupancy but are not used by the current occupancy calculation;
- no per-date `min_stay` or `max_stay` snapshot is returned.

Required design:

- extract or introduce a dedicated read-only ARI rates snapshot service;
- preserve certified Revenue rules rather than duplicating formulas in the Channex adapter;
- provide correct global occupancy context;
- return only date/rate/supported restrictions and sanitized decision metadata.

Distribution must document the unused blocked-date occupancy query as a Revenue Engine observation, not silently alter that policy.

## Channex response audit

Official ARI behavior permits HTTP `200 OK` while returning warning notifications for rejected values in a multi-value request.

Therefore:

```text
HTTP 200 alone != complete delivery success
```

A delivery can be marked `SENT` only when:

- the HTTP response is successful;
- the expected Channex task identifier is present;
- no validation warning indicates a rejected value;
- the response belongs to the expected staging/production host and property contract.

A validation warning is non-retryable without a payload/configuration change and must not be hidden as success.

## Frozen outbound schema proposal

### Enums

```text
ChannexAriMessageKind
- AVAILABILITY
- RATES_RESTRICTIONS

ChannexAriSyncMode
- INCREMENTAL
- FULL

ChannexAriScope
- EXACT_DATES
- DATE_RANGE
- FULL_HORIZON

DistributionOutboxStatus
- PENDING
- CLAIMED
- MERGED
- SUPERSEDED
- DEAD

ChannexAriDeliveryStatus
- READY
- PROCESSING
- RETRY_WAIT
- SENT
- DEAD
- SUPERSEDED

ChannexAriAttemptOutcome
- IN_FLIGHT
- SUCCESS
- RETRYABLE_FAILURE
- TERMINAL_FAILURE
- UNKNOWN_AFTER_LEASE
```

### DistributionOutboxEvent

Immutable durable intent created by a domain transaction.

Required fields:

```text
id
organizationId
propertyId
provider=CHANNEX
messageKind
syncMode
scope
dateFrom?               // inclusive, database DATE
dateToExclusive?        // exclusive, database DATE
dateKeys[]              // exact sparse dates when applicable
trigger
sourceEntityType?
sourceEntityId?
correlationId?
status=PENDING
availableAt             // coalescing boundary
claimedAt?
deliveryId?
createdAt
updatedAt
```

Required indexes:

```text
(status, availableAt)
(propertyId, messageKind, status)
(correlationId)
(deliveryId)
```

### ChannexAriDelivery

One coalesced canonical request with stable retry payload.

Required fields:

```text
id
organizationId
propertyId
connectionId
listingId
messageKind
syncMode
scope
dateFrom?
dateToExclusive?
dateKeys[]
status=READY
payload                  // ARI only; no PII or secrets
payloadHash
payloadValueCount
payloadBytes
attemptCount
nextAttemptAt?
leaseToken?
leaseExpiresAt?
channexTaskId?
httpStatus?
warningCount
lastErrorCode?
lastErrorSummary?
queuedAt
processingStartedAt?
sentAt?
deadAt?
createdAt
updatedAt
```

Required indexes:

```text
(status, nextAttemptAt)
(propertyId, messageKind, status)
(leaseExpiresAt)
(channexTaskId)
(correlation/full-sync lookup through linked outbox events)
```

The persisted payload must use canonical JSON ordering before hashing and remain below the Channex 10 MB request limit.

### ChannexAriDeliveryAttempt

Immutable evidence for every network attempt.

Required fields:

```text
id
deliveryId
attemptNumber
outcome
startedAt
completedAt?
durationMs?
httpStatus?
channexTaskId?
warningCount
retryAfterMs?
errorCode?
responseMeta?            // sanitized; no raw secrets/PII
createdAt
```

Constraint:

```text
unique(deliveryId, attemptNumber)
```

### ChannexAriPropertyState

Persistent property-level throttle and Full Sync guard.

Required fields:

```text
propertyId               // unique/primary key
availabilityNextAllowedAt?
ratesNextAllowedAt?
pausedUntil?
lastRateLimitAt?
lastSuccessfulAvailabilityAt?
lastSuccessfulRatesAt?
lastFullSyncRequestedAt?
lastFullSyncCompletedAt?
createdAt
updatedAt
```

The worker must serialize updates per property/message kind using a PostgreSQL advisory lock or equivalent database-safe claim.

## Coalescing contract

The coalescer processes PENDING intents whose `availableAt` has passed.

Partition key:

```text
propertyId + messageKind + syncMode
```

Rules:

- exact dates are unioned and deduplicated;
- overlapping ranges merge;
- adjacent ranges may merge;
- Full Sync never merges into incremental mode;
- a Full Sync can supersede older pending incremental intents inside its horizon;
- newer incremental intents created after the Full Sync snapshot remain pending;
- delivery payload is rebuilt from current canonical Pin&Go state, never from stale requested values;
- one domain event that affects both message kinds creates two outbox rows with one correlation ID.

Default coalescing delay:

```text
30–60 seconds per property
```

Availability from a confirmed booking may use the lower end of that range while still preserving batching.

## Rate-limit and retry contract

Official property limits:

```text
10 Availability requests/minute/property
10 Rates & Restrictions requests/minute/property
20 combined ARI requests/minute/property
```

Safe default spacing:

```text
at least 6.5 seconds between requests of the same message kind/property
```

Retry classification:

```text
429, network failure, timeout, 5xx
→ RETRYABLE_FAILURE
→ pause property for at least 60 seconds
→ exponential backoff with bounded jitter

400, 401, 403, 404, 422, mapping contract failure,
HTTP 200 with rejected-value warnings, missing task ID
→ TERMINAL_FAILURE
→ DEAD
→ Mission Control developer/host action according to public error policy
```

The worker must honor `Retry-After` when available.

A stale PROCESSING delivery returns to retry through lease recovery and records `UNKNOWN_AFTER_LEASE` for the interrupted attempt.

At-least-once ARI delivery is acceptable because these messages set canonical state. Duplicate network tasks must never produce duplicate local outbox or reservation records.

## Payload contracts

### Availability

Allowed fields only:

```text
property_id
room_type_id
date OR date_from/date_to
availability
```

No rate-plan fields or restrictions are included.

### Rates & Restrictions

V1 fields:

```text
property_id
rate_plan_id
date OR date_from/date_to
rate                         // positive integer in currency minor units
min_stay_arrival
min_stay_through
max_stay                     // when configured
```

Explicitly prohibited from this payload:

```text
availability
available
Room Type content updates
```

V1 unsupported declarations unless separately implemented:

```text
stop_sell
closed_to_arrival
closed_to_departure
multiple Room Types per Pin&Go property
multiple independent Rate Plans per Pin&Go property
```

The current arbitrary minimum rate floor of 1000 minor units must not silently alter Pin&Go pricing. A non-positive canonical rate is a contract error; positive Pin&Go rates are sent in minor units.

## Full Sync contract

Internal horizon:

```text
today through today + 499 days
500 date keys total
dateToExclusive=today + 500 days
```

One Full Sync operation creates exactly two deliveries:

```text
1 FULL AVAILABILITY request
1 FULL RATES_RESTRICTIONS request
```

Both share one correlation ID and produce two persisted Channex task IDs.

Full Sync is blocked when:

- mapping is incomplete;
- another Full Sync is active;
- the previous Full Sync is inside the 24-hour guard, unless a separately authorized override applies;
- generated request exceeds 10 MB;
- data is not sufficiently realistic for certification staging.

## Mission Control contract

Host-visible state should be limited to actionable failures.

Healthy state:

```text
last Availability task
last Rates & Restrictions task
outbound lag
pending delivery count
retry count
```

Automatic recovery states:

```text
COALESCING
READY
PROCESSING
RETRY_WAIT
```

Action-required states:

```text
mapping incomplete/ambiguous
credentials rejected
payload validation warning/rejection
recovery exhausted
request exceeds size limit
unsupported activation/archive transition
```

Raw Channex IDs may be retained for developer evidence but public UI should use `PIN_GO_CONNECT` terminology.

## Implementation gates

Before any code implementation:

1. Review and approve this producer/schema audit.
2. Confirm V1 unsupported restrictions: Stop Sell, CTA and CTD.
3. Confirm one Room Type and one Rate Plan per Pin&Go property for V1.
4. Confirm archive policy: distributed properties must disconnect before archive.
5. Confirm Revenue policy remains unchanged; Distribution only exports its certified output.

After approval, implementation begins one capability and one file at a time:

```text
policy tests
→ Prisma schema
→ migration
→ outbox service
→ snapshot builders
→ coalescer
→ delivery adapter
→ worker/retry/throttle
→ producer wiring
→ Mission Control
→ staging protocol
```

## Audit status

```text
Existing schema inspected: PASS
Reservation producers traced: PASS
Direct Booking producers traced: PASS
Property/pricing producers traced: PASS
Season and holiday producers traced: PASS
Blocked-date producers traced: PASS
Distribution enablement traced: PASS
Mapping security audited: PASS
Provisioning boundary audited: PASS
Credential paths audited: PASS
Availability source audited: PASS
Pricing source audited: PASS
Official response semantics reviewed: PASS
Durable schema proposed: PASS
Implementation authorized: NO
Production authorized: NO
```
