# Distribution rate refresh V1

Status: prepared, activation defaults off. No production variables or services are changed by this PR.

## Problem and behavior

Reservation mutations currently produce Availability intents, but occupancy-based Revenue rates can also change. Time passing changes lead-time and occupancy pricing without any mutation. Retiring the old monolithic pricing sync left no daily producer to renew the 500-day horizon.

The new process polls active distributed properties, validates the existing certified Channex mapping and writes intents to the existing durable ARI outbox. It never calculates a new price, calls Channex directly or modifies property/reservation/cleaning/access data. ARI Dispatch materializes current prices with the existing Revenue engine, including manual nightly overrides.

- Bootstrap: 500-day availability and complete supported rates/restrictions intents.
- Local-date rollover: availability for newly exposed horizon nights, including missed days after downtime, plus refreshed rates/restrictions for the current 500 days.
- Occupancy/configuration change or Revenue's UTC-date rollover: rates-only for the current horizon. Occupancy-only changes do not export availability or restrictions.
- Stable inputs: no new intent. Cancel/reactivate returning to a previous occupancy is compared against the latest snapshot, not any older matching snapshot.

Revenue currently uses UTC-day occupancy/lead-time calculations. The producer respects that existing boundary and separately renews the property-local horizon. It does not change the pricing formula or timezone policy. Overlapping active stays count occupied nights once, matching Revenue's union calculation. Reservations outside its lookahead do not cause occupancy-rate refreshes.

## Durability and isolation

A property-scoped advisory transaction lock and a Serializable transaction cover mapping checks, source reads and all intent writes. Only known rolled-back serialization conflicts retry, at most three total attempts. The latest refresh rate event stores the versioned input signature; it serves as a durable producer ledger after restarts and outbox merging. No schema migration is needed. Both bootstrap intents roll back if either write fails.

Existing dispatch retry/DEAD and audit semantics remain authoritative. A producer intent is not a delivery confirmation; a DEAD delivery requires the existing operator recovery, not unlimited duplicate producer intents. Keyset pagination visits all properties; one broken mapping cannot starve the rest. Logs expose identifiers/counts and sanitized codes only; idle cycles do not flood logs.

The 126-file certified core and its fingerprint guard remain unchanged. All added behavior lives outside that core. Cleaning is deliberately untouched under Freddie's audit-only instruction.

## Validation

- Policy/service tests: occupancy create/cancel/reactivate, overlaps, irrelevant reservations, UTC/local midnight, leap day and downtime, configuration ordering, ledger validation, default-off config, replay, rollback, lease fencing, tenant/distribution gating, pagination and bounded serialization retries.
- PostgreSQL contract: two real Prisma clients, competing producers, persisted replay, create/cancel/reactivate, horizon rollover and constraint-induced rollback. Uses only an explicit RATE_REFRESH_POSTGRES_TEST_URL on localhost and a disposable random schema. No production fallback.
- Strict TypeScript compilation and worker ESM bundle. noUncheckedIndexedAccess is disabled in this focused tsconfig to match existing certified dependency compilation; strict remains enabled. The original certified dependencies are not edited to satisfy broader inherited checks.
- Existing certified core fingerprint test.

## Publication and certification gates

1. Pass the PR CI, including the isolated PostgreSQL contract. Inspect the final diff.
2. Publish backend only after deployment authorization. This release adds no DB migrations and remains inactive without its separate worker.
3. Create one dedicated service on the reviewed main commit with railway.distribution-rate-refresh.json / npm run worker:distribution-rate-refresh. Initial DISTRIBUTION_RATE_REFRESH_ENABLED=false; DATABASE_URL references the existing database. This producer needs no Channex API key, messaging key or physical-access credential.
4. Certify in the existing certification environment with the dispatch worker initially disabled: first cycle creates two intents; repeated cycle creates zero; occupancy create/cancel/reactivate creates rates-only; midnight replenishes the horizon. Inspect materialized payloads, overrides, mapping, retries and rollback before live acceptance tests.
5. Authorize controlled activation with DISTRIBUTION_RATE_REFRESH_ENABLED=true. Default poll is 60 seconds, configurable 10–300 seconds. The cycle visits all properties sequentially; polling is not a guaranteed end-to-end delivery latency at large tenant counts.
6. Observe worker SUCCESS, bootstrap intents and ARI accepted task receipts. Confirm the actual OTA calendar/prices for a test property. Neither local tests nor Channex task acceptance prove downstream OTA delivery.

Rollback: set DISTRIBUTION_RATE_REFRESH_ENABLED=false on this producer. Existing already-enqueued intents remain durable and may still dispatch; inspect them if the rollback needs to stop pending transmissions too. Do not disable the unrelated Global Feed or guest operations.

The old dynamic-pricing-sync worker stays retired. Do not change cleaning or Casa Collores's checkout as part of this release.
