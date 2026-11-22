# Guest Journey isolated laboratory

The laboratory is separate from Pin&Go production and the Channex certification environments.
It runs real E4/E7 code against synthetic records and simulated providers. It does not certify
complete reservation-event coverage, physical delivery, uncorrelated-outcome recovery or the host Mission Control UI.

## Infrastructure boundary

- Project: `PinGo Guest Journey Lab` / `10619a4a-d72c-4997-b08d-4bad1b0fe60b`.
- Environment: `guest-journey-test` / `437014cf-52bf-4c3c-a92a-e1738d01d712`.
- Database: independent `Postgres`, database and user `guest_journey_lab`; private networking only.
- API: role `api`, read-only health and evidence endpoints. No product mutation routes.
- Communications worker: role `communications`, invokes the scoped E7 cycle with injected simulators, receipt recovery and the non-executing pre-check-in shadow planner.
- Evidence monitor: role `monitor`, observes waiting outcomes; it does not pretend to recover them.
- Every source is pinned to the reviewed laboratory commit. No merge or production deployment is required.

Each application service receives only:

```text
NODE_ENV=test
GUEST_JOURNEY_LAB_MODE=simulation
GUEST_JOURNEY_LAB_ROLE=api|communications|monitor
DATABASE_URL=${{Postgres.DATABASE_URL}}
OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS=AIRBNB,BOOKING_COM
```

Railway supplies the project/environment identity. The entry point rejects any other identity,
database name/user/host, external provider configuration and enabled production journey flags.
The canonical OTA channel policy is mandatory; a missing or incomplete value prevents startup.
The process installs a deny-all Node HTTP/HTTPS/fetch/TCP/TLS fence before importing product code.
Prisma's native engine receives only the validated private database URL. This is an application
process fence, not a claim that Railway has a network firewall installed.

Do not import production secrets, copy production data, connect locks or register provider webhooks.
There are no public database TCP proxies. The optional evidence page exposes only synthetic results,
has no mutation endpoints, and must never be repurposed to display real guest records.

## Build and startup

```sh
npm ci
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target esnext --types node src/guest-journey-lab/main.ts src/guest-journey-lab/isolation.test.ts src/guest-journey-lab/runtime.db.test.ts
node --import tsx --test src/guest-journey-lab/isolation.test.ts
npm run test:guest-journey-enterprise-e7-communications
```

API pre-deploy, only inside the explicitly validated laboratory:

```sh
node --import tsx src/guest-journey-lab/main.ts --prepare
node --import tsx --test src/guest-journey-lab/runtime.db.test.ts
```

The first command applies the repository migrations to the empty lab database and creates an
independent evidence schema. The second exercises real E4/E7 persistence and repeat execution.
All three roles start with `node --import tsx src/guest-journey-lab/main.ts`.
Deploy the API successfully before the two workers. The API healthcheck is `/ready`.

## Initial probes

| Fixture | Expected evidence |
| --- | --- |
| Accepted simulated SMS | One simulator call, a durable attempt, provider ID prefixed LAB_, simulated DELIVERED receipt |
| Empty provider acknowledgement | E7_SENDING and WAITING_FOR_EVIDENCE, no provider ID, no blind replay |
| Provider timeout | E7_SENDING and WAITING_FOR_EVIDENCE, no blind replay; recovery remains an open product gap |
| Late acknowledgement + delivered receipt | Provider ID retained after timeout; only the correlated receipt closes the intent; one immutable recovery audit |
| Late acknowledgement + failed delivery receipt | UNDELIVERED remains pending with host-visible attention, without automatic resend |
| Airbnb operational SMS | OBSOLETE under the existing channel policy, zero SMS calls; Channex delivery is not certified by this result |
| Repeat / reconnect / worker restart | Same call counts and attempt count; fixtures are never reset on startup |

The fixture outboxes are explicit. They do not prove that reservation creation, modification,
cancellation or checkout independently materialize every required communication.
Fixture identifiers include the deployed commit prefix, exposed as `fixtureRevision` in the evidence.
A new commit gets independent synthetic fixtures; older attempts remain in the database.
Restarts of the same pinned commit reuse the same records and must not increase provider calls.
The read-only page is an evidence monitor, not a replacement for the product's Mission Control.

## Reservation-to-obligation shadow: pre-check-in

`precheckinShadow` in `/evidence` now records a separate, non-executing parity probe.
Fourteen synthetic reservations live in a separate property under the lab organization.
Twelve start without message or dispatch records; two deliberately carry an email SENT marker
or an uncertain prior SMS. None has a journey, an executable intent or an APMS_PENDING outbox.
The planner reads the persisted reservation and prior communication evidence. It stores immutable
observations in `guest_journey_lab.precheckin_shadow`, unique by effect identity plus fingerprint.
Repeated unchanged observations, concurrent runs, reconnection and same-commit restart must leave
25 observations, zero executable intents, zero dispatchable messages and zero provider calls.

The clock is explicitly fixed at `2030-05-01T16:00:00Z`. This makes fixture outcomes reproducible;
it does not certify production scheduling or real-time event ingestion. No record is marked delivered
or complete. Every row exposes `receipt=NOT_CERTIFIED`, `claim=NOT_CREATED` and
`finalEvidence=OBLIGATION_ONLY`. Existing SENT records prevent blind re-creation but do not prove delivery.

| Reservation/event | Shadow obligation | Canonical owner | Current gap / boundary |
| --- | --- | --- | --- |
| Paid Direct Booking, four-hour window | Separate email and eligible SMS | Communications | First-send lab probe below; production ownership gate remains open |
| Consent absent, then eligible | Email remains separate from SMS | Communications | Consent must never reset effect identity or consume another channel |
| During stay | Pending SMS; no new pre-arrival email for an older booking | Communications | E7 currently retires PRECHECKIN at check-in; legacy permits SMS catch-up |
| Booking created after check-in | Email and eligible SMS | Communications | Same E7 time-window mismatch |
| Before window / unpaid / cancelled / checkout | Explicit ineligible or not-due reasons | Communications | No executable effects |
| Missing contacts | Explicit missing-recipient reasons | Communications | No invented recipient or delivery |
| Prior email SENT / uncertain SMS | Reconcile the existing effect; only the other channel remains required | Communications | No initial resend; no inferred delivery |
| Airbnb / Booking.com under blocked-external policy | One Channex obligation | Existing Channex operational dispatcher | Handoff and receipt certification remain open; no SMS/email fallback |
| OTA without usable contact trigger | One expected Channex obligation, visible trigger gap | Existing Channex operational dispatcher | Legacy worker contact selection cannot trigger this route |

Source contracts: `src/workers/reservation.worker.ts` (`processPreCheckinMessages`),
`src/services/preCheckinSms.service.ts`, `guest-journey-access-communications-bridge.policy.ts`,
`ota-guest-external-messaging.policy.ts`, `src/channex-messaging/ota-operational-guest.service.ts`,
and `guest-journey-communications-delivery-adapter.service.ts`. The established 11 legacy
pre-check-in tests run alongside 10 shadow policy tests and the real PostgreSQL certification.
This increment changes no production entry point or legacy sender.

Next gate: certify the shared legacy/GJ ownership fence before any external canary. The dedicated
first-send lab probe below opts into corrected arrival eligibility and receipt-gated completion;
the default production composition still does not enable this contract. Reservation changes, confirmation,
payment, identity/contract, access, Pin&Go Guest, cleaner/reminders, cancellation and checkout still
require their own event-to-obligation certification. This probe does not establish full parity.

Rollback of this laboratory increment: pin API and both workers back to the previous validated
lab commit (`c5a9268150a4d26c83d24d49923b03e403f07380`). Retain the additive shadow table and
fixture history; no data deletion or production configuration change is needed. A failed shadow
cycle is logged as `GJ_LAB_CYCLE_FAILED`; inspect the lab heartbeat and CI evidence before retrying.

## Direct Booking first-send simulation

The branch incorporates current `main` contracts before this increment, including the current
pre-check-in return-booking link and email templates. No main deployment is included.
`precheckinFirstSend` exposes a separate property with nine synthetic reservations and a clock
fixed at fixture creation. Seven start without communications; two carry legacy email or uncertain
SMS evidence. The producer uses the existing language, map, verification and SMS content helpers.
The default email adapter retains current main's delivery-time direct-booking link resolver.

The guarded lab producer commits the message outbox, normalized canonical REQUEST_COMMUNICATION
intent and materialization audit in one transaction. A failed audit rolls everything back.
Reservation-scoped advisory locking and deterministic per-channel message IDs prevent concurrent
or repeated creation. Existing message or dispatch evidence is preserved regardless of result.
The producer never invokes the general E4 supersession pass when adding another channel, so late
SMS consent cannot supersede a pending email. General E4 coexistence is not certified by this probe.

E7 is called with `firstSendContract=PRECHECKIN_DELIVERY_V1` only for this property. It checks native
Direct Booking provenance, payment, active status, cancellation, consent and the distinct email/SMS
windows both before fencing and immediately before dispatch. SMS catch-up during the stay is allowed;
email catch-up requires a booking created after check-in, matching legacy eligibility. Acceptance
retains E7_SENDING and WAITING_FOR_EVIDENCE. A separate simulated DELIVERED callback and the real receipt
reconciler close the intent and resolve its operational alert. No production caller opts into this mode.

| Synthetic event | Intent / owner / lease | Effect and receipt | Recovery and durable evidence |
| --- | --- | --- | --- |
| Before arrival | Two canonical intents; Communications; one claim each | Email + SMS; simulated Resend/Twilio DELIVERED | Two immutable materializations and receipt recoveries |
| During stay, older booking | SMS intent only | Arrival-details SMS, without “check-in today” | Same receipt closure; no new pre-arrival email |
| Booking created after arrival | Email + SMS intents | Both delivered by simulators | One attempt per channel |
| Consent arrives after email acceptance | Existing email preserved; new SMS intent | No email resend | Original pending email intent and claim unchanged |
| Consent withdrawn after materialization | SMS stays WAITING_FOR_EVIDENCE, APMS_PENDING | Zero SMS provider calls | HOST ACTION_REQUIRED; no blind rearming |
| Prior legacy email / uncertain SMS | Preserve prior effect; create only missing channel | No replay of uncertain legacy SMS | Existing rows remain visible, not marked delivered |
| OTA / cancellation | No new intents | No external fallback or delivery | Existing canonical owner and eligibility boundary preserved |
| Audit write failure | Transaction rolls back | No orphan message or executable intent | Integration test checks both tables |
| Repeat / concurrent creation / reconnect / restart | Stable effect and intent identities | No additional calls | Identical evidence and claim counts |

After late consent is exercised: 11 materialized intents, 11 attempts, 10 simulator calls and 10
confirmed simulated receipts; one withdrawn-consent SMS remains visibly pending. Twelve MessageLog
rows include the deliberately uncertain prior SMS. Every intent retains claimCount=1. These are
simulation-only counts, not a claim of real delivery. The unchanged earlier six-outbox probe and
25-observation shadow probe remain separate.

Remaining limits: production coexistence with legacy/general E4 requires a shared ownership gate;
reactivation after a pre-provider eligibility block, mutable-content reconciliation, real-time
scheduling, physical email/SMS delivery and the full lifecycle are not certified. Do not enable
the production first-send composition based on these results. Roll back this increment by pinning
the three lab applications to `d1000a3b07d39eb6a3ae81a7ceb5eb7d4c66e54b`, preserving fixture history.

## Receipt recovery boundary

The lab Communications worker invokes receipt reconciliation after its normal cycle. Production
workers do not invoke this new service. A late acknowledgement preserves only the provider ID;
it leaves the `E7_SENDING` fence intact. A confirmed DELIVERED/READ receipt must match the exact
message, reservation, organization, property, channel and existing durable attempt. Its timestamps
must belong to that attempt and its provider ID must identify exactly one message.

Reconciliation performs no provider calls. One serializable transaction compares the pending
intent, records the receipt fingerprint, marks it successful, appends immutable audit evidence and
resolves its operational alert. A failed audit write rolls back the transition. Historical send
attempts, claim counts and retry budgets are preserved. Concurrent reconciliation cannot close it twice.

Without sufficient evidence, the send fence stays in place and a HOST-visible ACTION_REQUIRED item
is persisted. PENDING, RETRYABLE and CLAIMED states cannot clear that alert. The lab API displays these
canonical issue records; this does not certify the frontend Mission Control experience.

After the six fixture scenarios finish: six durable attempts, five simulator calls, one receipt
recovery audit, one resolved alert and three open alerts are expected. Repeating cycles and restarting
the worker must preserve those counts. The PostgreSQL test also injects audit failure, wrong-tenant
access and two concurrent reconcilers. No migration or dependency change is needed for this step.

Remaining limits: a provider response lost with the process, an acknowledgement with no identifier,
or a callback arriving before provider-ID persistence cannot yet be recovered automatically. A durable
correlation/inbox contract is still required. Initial accepted sends still use the existing completion
rule; full delivery-gated completion and safe retries after provider-reported failure remain pending.

## Controlled operation

1. Keep production Guest Journey OFF and the traditional flow operating.
2. Change one logical component, compile and run focused tests before continuing. Stage named files only.
3. Pin an approved lab commit; observe terminal SUCCESS for each deployment.
4. Inspect `/evidence`: messages, intents, leases, attempts, provider call counts, simulated receipts and heartbeats.
5. Restart only the lab communications worker and compare the durable call counts before and after.
6. Treat WAITING_FOR_EVIDENCE as an unresolved outcome, not successful delivery.
7. For a lab rollback, stop new lab work and select a previously verified lab build; preserve the database for investigation.
8. Real delivery tests require a separate explicit scope with controlled recipients and dedicated credentials.
   The simulation entry point intentionally refuses such credentials.

Production expansion requires the complete event → intent → owner → lease → effect → provider →
receipt → recovery → final evidence matrix, Communications approval before other Owners, and a
separately authorized canary. This initial lab is infrastructure and a bounded regression harness.
