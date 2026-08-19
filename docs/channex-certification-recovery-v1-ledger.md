# Pin&Go APMS — Channex Certification Recovery V1 Ledger

## Purpose

This ledger is the durable continuity record for the Channex PMS certification
recovery. A chat summary, a green deployment, a local test result and a Channex
certification result are different kinds of evidence and must never be treated
as interchangeable.

This file records evidence only. It does not authorize a Channex call, a worker
activation, a merge, a production deployment or a production data change.

## Frozen recovery baseline

```text
Repository: freddiefernandezmaysonet-netizen/pin-go-backend
Branch: audit/channex-certification-recovery-d7e1a829
Draft PR: #36
PR base: sprint/distribution-engine-channex-outbound-ari-v1
PR base SHA: aab98071a6b7119008bb65de3e85a71b2d974cef
Recovery HEAD: f5cb2b23bc2294128c05827aa23d1a4e5ba15ac8
Original recovery commit: d7e1a829897bb196093ca48543cdb81eef2865fd
Production authorized: NO
Merge authorized: NO
```

The PR description still identifies `d7e1a829` as the audited commit and says
that no staging deployment occurred. GitHub currently reports `f5cb2b23` as the
PR HEAD and successful staging deployments for the API, ARI dispatcher,
webhook-recovery worker and Global Feed worker. The PR description must not be
used as current execution evidence until it is reconciled with this ledger.

## Contract sources

Evidence is evaluated in this order:

1. Channex rejection email for the first Pin&Go certification.
2. [PMS Certification Tests](https://docs.channex.io/api-v.1-documentation/pms-certification-tests).
3. [Availability and Rates API](https://docs.channex.io/api-v.1-documentation/ari).
4. [Bookings Collection and Booking Revision Feed](https://docs.channex.io/api-v.1-documentation/bookings-collection).
5. [Webhook Collection](https://docs.channex.io/api-v.1-documentation/webhook-collection).
6. [API Rate Limits](https://docs.channex.io/api-v.1-documentation/rate-limits).
7. [Best Practices Guide](https://docs.channex.io/guides/best-practices-guide).

If implementation, prior chat commentary or historical evidence conflicts with
the current official Channex contract, Channex wins.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `CODE_PASS` | The current HEAD implementation is covered by passing automated tests. |
| `MOCK_PASS` | The current HEAD produces the expected local contract without a Channex call. |
| `STAGING_EVIDENCE_IMPORTED` | Sanitized evidence from the exact current HEAD and frozen mapping is present in this ledger. |
| `STAGING_EVIDENCE_SOURCE_SHA_PENDING` | Sanitized staging evidence is imported, but the exact deployed source SHA at execution time is not yet proven. |
| `PASS_BY_CHANNEX_EMAIL` | Channex explicitly accepted the result in the rejection email. |
| `SKIPPED_BY_CHANNEX_EMAIL` | Channex explicitly accepted omission of the test in the rejection email. |
| `UI_EXECUTION_CONFIRMED_EVIDENCE_PENDING` | The user confirmed execution from the staging UI, but exact Task/request evidence is not yet stored in the repository. |
| `HISTORICAL_PASS_DIFFERENT_COMMIT` | Useful staging evidence exists, but it belongs to an older commit and cannot certify the current HEAD by itself. |
| `BLOCKED` | A confirmed contract violation prevents continuation. |
| `NO_CONFIRMADO` | Available evidence is insufficient. This is not a failure and must not be presented as one. |

Only `PASS_BY_CHANNEX_EMAIL`, or a later explicit Channex acceptance backed by
the exact evidence package, is an external certification PASS.

## Frozen certification mapping

All scenarios must resolve this exact mapping before execution:

```text
Organization: cms0zipf70000pf6n7is2ncwr
Pin&Go property: cms0zipff0002pf6n5h3d500k
Channex property: 1d699e11-593c-4a3d-b66a-28741759e82f
Channex Room Type: 31a7161d-cd47-4f38-b5f4-4b9e11d4e6f9
Channex Rate Plan: daa6211c-bd9b-455f-b526-4136550b9a92
Connection: cms0zipfl0004pf6n5i0z6oxt
Listing: cms0zipfr0006pf6nu8tzzbr9
```

The preflight must abort on any mismatch. No Remanso or unrelated
Certification/Demo identity may be substituted.

## Current HEAD verification

Verified locally against `f5cb2b23bc2294128c05827aa23d1a4e5ba15ac8`:

```text
Prisma multi-file schema validation: PASS
Prisma models generated:
  ChannexAriPropertyState: present
  DistributionOutboxEvent: present
  PropertyNightlyRestriction: present
Backend test files: 65
Tests: 531
Pass: 531
Fail: 0
Skipped: 0
```

The complete test discovery was executed with Node's test runner and the `tsx`
loader. No real Channex request was made by that verification.

GitHub evidence for the same HEAD:

```text
Draft PR open: PASS
PR merged: NO
Railway Staging Config Certification: PASS
Channex Booking Lifecycle Certification: PASS
pin-go-api-staging deployment: success
pin-go-channex-ari-dispatch-staging deployment: success
pin-go-pms-webhook-recovery-staging deployment: success
pin-go-channex-global-feed-staging deployment: success
```

A successful deployment proves build/runtime deployment status. It does not by
itself prove a certification payload, Task ID, webhook delivery result or
database migration state.

## Rejection regression matrix

The user confirmed that the certification steps were recreated from the real
Pin&Go staging UI. Sanitized ARI delivery and booking lifecycle evidence was
then imported read-only from `Postgres-Staging` on 2026-08-11. The source SHA
active for each 2026-08-09/10 execution is not directly persisted in those
records, so imported rows remain `STAGING_EVIDENCE_SOURCE_SHA_PENDING` rather
than `STAGING_EVIDENCE_IMPORTED` or external PASS.

| Test | Channex contract / rejection result | Current HEAD local evidence | Staging/Channex evidence status | Required closure evidence |
| --- | --- | --- | --- | --- |
| #1 Full Data Update | 500 days; exactly one Availability and one Rates & Restrictions request. Rejection email: passed. | `CODE_PASS`, `MOCK_PASS` | `PASS_BY_CHANNEX_EMAIL`; new execution evidence not imported | Preserve accepted Task/request IDs if available; do not repeat unless Channex requires it. |
| #2 Single Date / Single Rate | One `2026-11-22` rate delta for the frozen rate plan; no unrelated restrictions. Rejection warned that the old request was snapshot-shaped. | `CODE_PASS`, `MOCK_PASS` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; corrected rate-only request imported | Prove deployed source SHA and resulting Channex value; exclude the older snapshot-shaped attempt. |
| #3 Single Date / Multiple Rates | Rejection email accepted omission because Pin&Go has one room type/rate plan. | Contract fixture present | `SKIPPED_BY_CHANNEX_EMAIL` | Preserve the rejection email as skip authority. |
| #4 Multiple Date Update | Mandatory for vacation rentals; one rate update for `2026-11-01..2026-11-10` on the single rate plan. | `CODE_PASS`, `MOCK_PASS` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; one rate-only range request imported | Prove deployed source SHA and resulting Channex values. |
| #5 Min Stay | Mandatory because Pin&Go supports Min Stay; one update for `2026-11-23` on the single rate plan. | `CODE_PASS`, `MOCK_PASS` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; Min Stay-only request imported | Prove deployed source SHA and resulting Channex values. |
| #6 Stop Sell | Rejection email accepted omission because Pin&Go does not support Stop Sell. | Contract fixture present | `SKIPPED_BY_CHANNEX_EMAIL` | Preserve the rejection email as skip authority. |
| #7 Multiple Restrictions | Mandatory for Pin&Go's supported restriction subset; one request for the single rate plan. | `CODE_PASS`, `MOCK_PASS` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; exact supported restriction subset imported | Prove deployed source SHA and resulting Channex values. |
| #8 Half-year Update | One update covering `2026-12-01..2027-05-01` for the single rate plan. | `CODE_PASS`, `MOCK_PASS` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; exact half-year request imported | Prove deployed source SHA and resulting Channex values. |
| #9 Single Date Availability | Frozen Room Type; vacation-rental value accepted by the rejection feedback as `1` or hotel scenario value `7`, never the prior wrong mapping. | `CODE_PASS`, `MOCK_PASS` with availability `1` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; exact date/value/mapping imported | Prove deployed source SHA and resulting Channex value. |
| #10 Multiple Date Availability | Frozen Room Type; merged `date_from/date_to` sequence, not repeated single-date objects. | `CODE_PASS`, `MOCK_PASS` with `2026-11-10..2026-11-16`, availability `1` | `STAGING_EVIDENCE_SOURCE_SHA_PENDING`; final corrected compacted request imported | Prove deployed source SHA and resulting Channex values; exclude earlier availability-zero attempts. |
| #11 Booking Receiving | NEW/MODIFICATION/CANCELLATION through webhook/Booking Revision Feed; persist before ACK; no Booking Find. | `CODE_PASS`, `MOCK_PASS` | Partial staging evidence imported: three Feed revisions, one reservation, persist-before-ACK and `booking_find=0`; `notes.success` and explicit lifecycle labels remain `NO_CONFIRMADO` | Obtain Channex delivery `notes.success=true`, direct NEW/MOD/CANCEL classification, source SHA and PMS screenshot. |
| #12 Rate Limits | 10 Restrictions/min/property, 10 Availability/min/property, 20 ARI total; queue, batching and exponential backoff. | `CODE_PASS`, `MOCK_PASS` | Current workflow tests PASS; real load test not required by the form unless Channex requests it | Current limiter/queue evidence and affirmative form response. |
| #13 Update Logic | Change-only normal updates; no timer Full Sync; Full Sync no more than once per 24 hours when required. | `CODE_PASS`, `MOCK_PASS` | Current workflow tests PASS | Outbox delta evidence and 24-hour Full Sync policy evidence. |

## Imported staging evidence — 2026-08-09/10 UI executions

Source: read-only SQL in Railway `staging-channex-certification` /
`Postgres-Staging`, collected 2026-08-11. Frozen property, Channex property,
Room Type and Rate Plan IDs matched the manifest. Every listed ARI delivery was
`SENT`, HTTP 200, with warning count 0.

| Test | Delivery ID | Attempt ID | Request ID | Channex Task ID | Sanitized exact values |
| --- | --- | --- | --- | --- | --- |
| #2 corrected | `cmsm2im280000p3gi3zabwywi` | `cmsm2tyfb0001p3qwb72diyhd` | `GMozOnejTzv7HicBFsMB` | `507ca70e-9265-4b2e-8125-a7426483f3d1` | `date=2026-11-22`, `rate=33300`; no restriction fields |
| #4 | `cmsm3fin30000p30uycbaysgf` | `cmsm3j7dh0001p35kf1dklvuc` | `GMo0TL1PMTXiz1IBGPfh` | `dfdb43b6-5685-494d-b278-00a1f582be7f` | `date_from=2026-11-01`, `date_to=2026-11-10`, `rate=24100` |
| #5 | `cmsncuagv0000lb18fbvto30t` | `cmsncuai10002lb18xa154l31` | `GMp5gycvZscjtSwAJYXh` | `0597e4e5-6661-44a8-a090-1211d6633c5a` | `date=2026-11-23`, `min_stay_arrival=3`, `min_stay_through=3` only |
| #7 | `cmsnf48vc0000pj18komptqmw` | `cmsnf49080002pj18kf3cnpjo` | `GMp8_XgjOi3ZtVwAMSWB` | `7ee8acc2-bf07-42df-8054-2b392572ca08` | `2026-11-01..2026-11-10`, Min Stay `1`, Max Stay `4`; no rate/CTA/CTD/Stop Sell |
| #8 | `cmsngc7m50000s218vo7231cc` | `cmsngc7o50002s218qtgjvuuw` | `GMp-2wcvzFA00o8ANzch` | `967e0b74-5aea-469f-8bda-ec6dfe24b2fc` | `2026-12-01..2027-05-01`, `rate=43200`, Min Stay `2` |
| #9 | `cmsnk1yii0000om18054ywjbv` | `cmsnk1ym00002om18ay37ug5a` | `GMqEh-5ak0uwyt8AS3qB` | `7cfe7ea9-d6b6-4889-98f8-32db796fe51c` | `date=2026-11-21`, `availability=1`, frozen Room Type |
| #10 corrected | `cmsnmmxof0000t6183ijo7o9l` | `cmsnmmxsq0002t61844buz6aj` | `GMqIefBNzBW9aooAUlwh` | `0bb3db50-498a-4cc8-bce1-00aeb7cd1050` | one merged range `2026-11-10..2026-11-16`, `availability=1`, frozen Room Type |

An older #2 delivery from 2026-08-07 carried `max_stay` and Min Stay fields
and must not be submitted as the corrected delta. Earlier #10 attempts carried
availability `0`; only the final corrected delivery above matches the frozen
scenario. No evidence row is promoted to external PASS without Channex review.

### Imported booking lifecycle evidence

```text
Channex booking ID: 10f76863-615f-4780-9c2e-23b0e78c4c93
Pin&Go reservation: cmsnnsf670002rv18wnq4ykg6 / PG-2026-000004
Reservation count for booking: 1
Final reservation status: CANCELLED
Ingest mechanism for all three revisions: BOOKING_REVISION_FEED
Event status for all three revisions: PROCESSED
Persist audit status for all three revisions: SUCCESS
ACK audit status for all three revisions: SUCCESS
booking_find matches in ApmsAuditEntry: 0
booking_find matches in WebhookEventIngest: 0

Revision 18a424dc-7cdd-4308-97b0-fcaf09251591
  persistence completed: 2026-08-10 20:03:15.064 UTC
  ACK started:           2026-08-10 20:03:15.076 UTC
  ACK completed:         2026-08-10 20:03:15.298 UTC
  persistence before ACK: 12 ms

Revision 341565e3-f86c-4a33-acf8-ee9df5b1bff3
  persistence completed: 2026-08-10 20:22:15.843 UTC
  ACK started:           2026-08-10 20:22:15.853 UTC
  ACK completed:         2026-08-10 20:22:16.070 UTC
  persistence before ACK: 10 ms

Revision b72b71d8-aec0-459d-887a-d52f271e91d5
  persistence completed: 2026-08-10 20:27:16.039 UTC
  ACK started:           2026-08-10 20:27:16.050 UTC
  ACK completed:         2026-08-10 20:27:16.249 UTC
  persistence before ACK: 11 ms
```

The sequence is consistent with NEW, MODIFICATION and CANCELLATION because one
reservation was created, updated and finally cancelled. The lifecycle label is
not stored directly in the imported rows, so that classification remains an
inference. Channex webhook delivery `notes.success=true` is also not stored in
Postgres and remains `NO_CONFIRMADO`.

## Historical staging evidence retained

Historical evidence is regression context, not a substitute for current-HEAD
certification evidence.

### Incremental ARI staging closure

Source: `docs/channex-outbound-ari-certification-v1.md`.

```text
Commit: 49b64b0facd2f29d09d67a9a10beaa98edc6d0bb
Environment: staging-channex-certification
Single-date Availability: PASS
Single-date Rates & Restrictions: PASS
Frozen mapping: matches this ledger
HTTP status: 200
Warnings: 0
Channex Inventory UI verification: user-confirmed PASS
Status in this ledger: HISTORICAL_PASS_DIFFERENT_COMMIT
```

### Controlled Booking Revision Feed closure

Source: `docs/channex-staging-global-feed-activation-certification.md`.

```text
Commit: 354b9516e13e3955e4bb38c871672547e4129494
Environment: staging-channex-certification
Revision: 17096d6b-8c67-4b76-8517-674a830427bf
Booking: ca9d4ac3-881c-4205-92ec-866fec3c427c
Pin&Go reservation: PG-2026-000002
Persistence completed: 2026-07-27T23:41:06.369Z
ACK started: 2026-07-27T23:41:06.377Z
ACK completed: 2026-07-27T23:41:06.649Z
Persistence before ACK: PASS by 8 ms
Duplicate reservations: 0
Target absent from Feed after ACK: PASS
Long-running Global Feed activation: false
Production changes: 0
Status in this ledger: HISTORICAL_PASS_DIFFERENT_COMMIT
```

This historical run proves that the canonical Feed mechanism has worked in
staging. It does not prove `notes.success=true` or the NEW/MOD/CANCEL evidence
for the recovery HEAD.

## Evidence import record

For each UI staging execution, add one sanitized record with this shape:

```text
Test number:
Execution timestamp UTC:
Source commit SHA:
UI action:
Frozen mapping preflight: PASS/FAIL
Endpoint:
Request ID:
Channex Task ID, if returned:
Sanitized exact request body:
Sanitized exact response body:
HTTP status:
Warning count:
Channex property ID:
Room Type ID, if applicable:
Rate Plan ID, if applicable:
Verification GET result:
Outbox ID:
Delivery ID:
Attempt ID:
Final status:
Evidence source:
```

For test #11 also require:

```text
Lifecycle: NEW/MODIFICATION/CANCELLATION
Revision ID:
Stable Channex booking ID:
Pin&Go reservation ID/number:
Webhook HTTP status:
Channex delivery notes.success:
Ingest mechanism:
Persistence completed at:
ACK started at:
ACK completed at:
ACK status:
Reservation count for booking:
booking_received_via_booking_find count:
PMS screenshot reference:
```

## Mandatory gates

Before another real Channex request:

1. Import and review existing UI execution evidence first.
2. Do not repeat a scenario whose exact evidence already satisfies Channex.
3. Show expected payload and compare it with the official contract.
4. Confirm the frozen mapping preflight.
5. Require the relevant current-HEAD mock test to pass.
6. Obtain explicit authorization for that individual real request.
7. Abort immediately if the actual body differs from expected.

Before submission:

```text
No BLOCKED rows
No NO_CONFIRMADO mandatory rows
No UI_EXECUTION_CONFIRMED_EVIDENCE_PENDING mandatory rows
Only Channex-authorized SKIPPED rows
Every claimed PASS linked to exact evidence
Booking Find events for #11 = 0
Production changes = 0
```

## Next controlled step

Perform a read-only evidence inventory against the staging audit records for
the UI executions already completed. Populate this ledger with existing
request IDs, Task IDs, sanitized payloads, responses and booking revision/ACK
evidence. Do not execute another Channex request during evidence inventory.
