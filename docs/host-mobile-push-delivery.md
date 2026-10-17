# Host push delivery candidate — disabled

This extends the unmerged PR472 registry with a metadata-only PostgreSQL delivery ledger and an explicit one-cycle process. No API server import, schedule, Railway service, feature flag, credential, deployment, real provider request or store build is configured by this change.

## Source and scope

The producer reads current OperationalIssue rows that are HOST-visible, ACTION_REQUIRED, actionRequired and unresolved, with an active property and an opted-in Host device. Supported sources are the canonical PIN_AI_GUEST_INCIDENT engine, CLEANING targets and ACCESS targets. A single source episode (`reopenedCount`) creates at most one ledger row per device/user. Repeated source updates, multiple producers and process restarts cannot create a second row for that episode. A genuinely reopened case can create a new alert. The original queued event expires after 24 hours; later source signals do not renew that queued alert's expiry.

GUEST_MESSAGE now has a separately disabled producer for canonical ChannexAIInbound NEEDS_HOST records whose thread is HUMAN, not sending and not leased. A namespaced inbound identity creates at most one row per message/device/user. A MESSAGING operational issue remains excluded: an outbound communications failure is not an inbound guest message. This coverage follows the existing automatic-inbox ingestion/escalation flow; it does not cover all inbox traffic or infer whether a Host has read a message. Exact per-Host read receipts are described below.

The delivery process requires all of:

- `HOST_MOBILE_PUSH_DELIVERY_ENABLED=true` (everything else is off).
- `HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS`: a nonempty JSON array of up to 50 exact property IDs, intended for controlled certification first.
- `HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE`: an explicit UTC timestamp ending in Z. Only subsequent source signals are materialized. Existing queued work is checked against the current allowlist/cutoff again.
- `HOST_MOBILE_PUSH_EXPO_ACCESS_TOKEN`: a separately configured provider access token; provider configuration is checked before connecting to PostgreSQL.
- The existing independent token encryption keyring. No key or token is included here.

The future controlled invocation is `node --import tsx src/workers/host-mobile-push.worker.ts --once`. The process requires the explicit `--once` argument. Nothing schedules it; infrastructure activation needs a later authorized step. Running it with the default environment returns disabled without database/provider work.

## Inbound attention candidate — separately disabled

`HOST_MOBILE_PUSH_MESSAGES_ENABLED=true` additionally requires the existing `CHANNEX_HOST_INBOX_ENABLED` and valid OTA Connection Center configuration. No settings are changed here. When disabled, the repository never queries the optional inbound tables, and the adapter makes no Channex requests. Existing queued message work cannot send after disabling this gate. Receipt reconciliation remains read-only and independent.

The adapter reuses the canonical inbox parser/transport behind a GET-only wrapper. It validates the exact active tenant/property/group mapping before fetching the thread and first 25 messages. It does not construct the automatic responder or expose reply operations. Before push dispatch, the latest unambiguously ordered message must be the expected guest message, the thread must be open, the thread summary and message collection must agree, and the original provider timestamp must be within 24 hours and at or after the configured cutoff. Host/property replies, newer messages, closed threads and stale/future messages skip the alert; ambiguous order, inconsistent reads and provider errors defer five minutes within the original event expiry.

After that external read, the process re-reads local session/user/property/device/preference authority. Source and thread revisions must still match. The atomic SENDING boundary requires fresh local policy and external evidence under five seconds old, current NEEDS_HOST/HUMAN state and no active responder lease/send. No provider call occurs within a database transaction. Channex can change immediately after the read; this is a freshness check, not a distributed atomic lock or a claim that the guest message is unread. The Host app reauthorizes its normal Messages destination after a tap.

No text, attachments, thread title or remote error body enters the notification ledger/payload/log. The message alert is generic English with INFO severity and cannot bypass quiet hours. These sources are read only: existing Channex responders, controls, receipts, webhooks and migrations are unchanged. General non-AI inbound ingestion remains separate work.

## Per-Host exact-message read receipts — disabled

The separate `HOST_MOBILE_MESSAGE_READ_ENABLED=true` gate enables native GET `.../threads/:threadId/mobile-messages` and POST `.../threads/:threadId/mobile-read`. The POST accepts only `{messageId, page}` and re-fetches that canonical page (25 items) through the existing scoped inbox runtime. Only an exact visible guest message can be acknowledged. Current signed native session authorization is enforced before and after the external read. Browser Origin/cookie requests, supplied actor IDs, timestamps and bulk watermarks are rejected.

Host PR7 adds a separate default-off `EXPO_PUBLIC_HOST_MESSAGE_READ_ENABLED` capability. A Host explicitly selects **Mark as read** for a displayed guest message. Loading a page or tapping a push does not acknowledge unread content. The client binds reads and acknowledgements to the same captured session, aborts on background/unmount, rejects late/account-changed confirmations, and displays Read only after a matching server confirmation. An uncertain response can be recovered by Refresh; no automatic retry occurs.

The additive HostMobileMessageRead table stores only the organization/user/property/thread/message identity and the first acknowledgement time. Concurrent marks are idempotent. No guest/provider read receipt is sent and no conversation ownership/action state changes. This is per-message state on the viewed page, not a whole-inbox unread count. New/off-page messages and other Hosts remain unread. The push producer, current-policy read and atomic send predicate all suppress a message acknowledged by that recipient. A push already sent cannot be withdrawn. Read receipts are conservatively retained; retention review remains a release gate.

## Durable states and provider uncertainty

QUEUED → CLAIMED → SENDING is persisted before the network call. PostgreSQL `FOR UPDATE SKIP LOCKED`, an owner, a monotonically increasing lease epoch and a 45-second lease coordinate independent workers. Expired CLAIMED work can be claimed again; an expired SENDING attempt becomes terminal UNKNOWN, with no automatic resend. Late results from the old owner cannot overwrite the replacement epoch. An acknowledged provider ticket is persisted as ACCEPTED, with its receipt due after 15 minutes. Receipt reads have their own quota and can safely resume after a CHECKING lease expires. Missing/erroring receipt reads repeat at five-minute intervals for up to 23 hours after acceptance. A missing final receipt becomes UNKNOWN.

Explicit HTTP 429 or per-ticket MessageRateExceeded responses allow at most three attempts with increasing backoff. Network errors, timeouts (including JSON parsing), malformed/mismatched tickets and HTTP 5xx responses become UNKNOWN, even though Expo generally recommends retrying transient failures. This conservative choice avoids silently duplicating a notification whose acceptance cannot be recovered. There is no hidden SDK retry. UNKNOWN has no automatic requeue path in this candidate; operational reconciliation remains a release gate.

A ticket means Expo accepted the request. PROVIDER_ACCEPTED means the receipt confirms handoff to FCM/APNs. Neither means the phone displayed the notification, nor that the Host read it. Expo itself can deliver duplicates downstream; server fencing is not an exactly-once device-delivery guarantee.

## Current authorization and privacy

Dispatch re-reads the current device binding, active Host user/role/tenant, canonical source episode/state/visibility, active property, preference and session through the existing canonical session inspection policy. It does not extend human session activity. Before SENDING, an atomic database predicate repeats the critical scope/session checks, requires the same preference revision and a policy snapshot under five seconds old, and checks current quiet hours. UTC instants are compared explicitly against the existing timezone-free Prisma columns, independently of the PostgreSQL session timezone. Session idle/absolute limits come from the canonical policy constants. Registration expiry or best-effort logout cleanup alone never authorizes delivery. A revoked/rebound/changed device cannot inherit queued work from its previous binding.

Only generic English titles/body and allowlisted event/organization/property/target metadata are constructed. No guest name, message text, private note, reservation credential, lock code, supplied URL, token or provider error body is copied into the ledger or logs. Android uses the app's `host-operations` channel and finite event expiration. The app independently reauthorizes navigation after a notification tap.

The token reader verifies the exact Host EAS project/platform, strict versioned AES-GCM envelope, original organization/user/session/hash authenticated data and decrypted token hash. It can read retained older key IDs while registrations encrypt with the active write key. Old keys must remain available while any live registration references them; removing one causes TOKEN_UNAVAILABLE deferral, never an unencrypted fallback. Every re-registration increments the binding version, writes with the active key and invalidates older queued device snapshots, including registrations in the same millisecond. In-place bulk key migration is not implemented here. Independent bounded maintenance is described below.

DeviceNotRegistered from a ticket or receipt retires only the exact original device/user/session/update-time/monotonic-version binding, transactionally with that delivery result. A delayed receipt cannot revoke a subsequently registered replacement. Receipt checks can finish after logout or source resolution because they only reconcile an already-sent attempt and cannot send another notification.

The draft registry SQL now creates four additive tables, including HostMobilePushDelivery. This migration remains unapplied outside disposable tests. The ledger uses scalar source/device/user references intentionally: current reads are authoritative, and deletion cannot turn historical metadata into access. Maintenance retains active-source deduplication records and unresolved UNKNOWN outcomes; these are not subject to unconditional age-based deletion.

## Independent maintenance candidate — disabled

`node --import tsx src/workers/host-mobile-push.worker.ts --maintenance-once` requires its own `HOST_MOBILE_PUSH_MAINTENANCE_ENABLED=true` and a nonempty JSON `HOST_MOBILE_PUSH_MAINTENANCE_ORGANIZATION_IDS` allowlist of at most 50 exact tenant IDs. Delivery activation cannot enable it. With default configuration it returns before database access. It never constructs a provider, enqueues notifications, recovers leases or sends messages. No schedule is installed.

Each transaction deletes at most 500 delivery rows and 500 device rows, uses `FOR UPDATE SKIP LOCKED`, a five-second SQL statement deadline and a ten-second transaction timeout. Counts are emitted without IDs or private data. The row cap bounds mutations, not database scan cost; query plans and volume must be reviewed before broad activation.

Message ledger records are conservatively retained pending their own source-retention review. Other delivery cleanup requires PROVIDER_ACCEPTED, FAILED or SKIPPED, both update and event expiry older than 30 days, no lease, and an absent canonical source. Any existing source (even resolved) preserves the deduplication identity. UNKNOWN, queued/sending work and pending receipts are always retained. UNKNOWN still requires a separate reviewed reconciliation process; cleanup never interprets uncertainty as a failed send or authorizes a resend.

Device cleanup requires the last update and either expiry or revocation to be older than 30 days. Fresh registrations and active devices are preserved. Scalar ledger records can outlive a removed device; live dispatch then denies authority while read-only receipt reconciliation can finish. Re-registering a token after its old registration was purged creates a new device identity. No permanent deletion of old evidence or tokens was executed outside disposable tests.

## Validation and remaining gates

Unit tests cover encryption/key versions/tampering, fixed provider transport, ticket/receipt distinctions, deadlines, unknown results, quiet hours, changed scope/current authority, disabled behavior and bounded known-rejection retries. The isolated PostgreSQL suite covers concurrent producers/claims, fresh dispatch authorization, cross-tenant denial, stale-owner fencing, pre/post-send crash recovery, exact device retirement, deduplication/reopened cases and a complete synthetic send/receipt cycle. Real provider transport is replaced in tests. CI runs strict types, emitted builds and the original Host/guest runtime regression suites.

Local validation: 20 push unit tests pass, seven scope-verifier tests pass, strict type checks/emitted builds and Prisma validation pass. All ten database scenarios (eleven Node test results including their parent) pass through a disposable PGlite/PostgreSQL-WASM mirror, including a non-UTC database session. The unchanged base schema plus the actual candidate SQL has zero schema differences against the candidate datamodel. This serializing local mirror validates SQL and state behavior; native PostgreSQL CI is still required for real concurrent-lock certification. The broader local Host command passes 45 tests and skips four native PostgreSQL suites when no database flag is set.

Still required: current-head native PostgreSQL/CI evidence; general non-AI inbound coverage and whole-inbox unread summaries; operational handling of UNKNOWN/provider credential failures; maintenance volume/query-plan review; provider credential and APNs/FCM readiness review; explicit controlled backend availability; physical iOS/Android permission, foreground/background/cold-tap, quiet-hour, logout/account-switch and delivery tests. Keep both PRs Draft. No merge, deployment, activation or store build is included.

Provider contract checked 2026-10-17: https://docs.expo.dev/push-notifications/sending-notifications/ (single-message ticket/receipt formats, DeviceNotRegistered, 15-minute receipt check, 24-hour receipt retention, enhanced push security and finite expiration).

Previous-head evidence: all 44 workflows passed at `a16f29031af71128505c090baa44460b9f463ba3`, including 50 Host unit/native PostgreSQL results. That evidence predates this maintenance addition; the new head requires its own CI certification.

Previous maintenance-head evidence: all 44 workflows passed at `778a4651959248c974966a9ffa7acf89efef346c`, including 52 Host unit/native PostgreSQL results. The inbound addition requires new exact-head CI evidence.

Read-state addition: local signed HTTP tests and isolated SQL tests verify actor isolation, exact-message idempotence, session revocation after external reads and suppression at the send boundary. Its exact-head CI evidence is recorded in the draft PR.
