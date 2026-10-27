# Guest Journey isolated laboratory

The laboratory is separate from Pin&Go production and the Channex certification environments.
It runs real E4/E7 code against synthetic records and simulated providers. It does not certify
complete reservation-event coverage, physical delivery, uncorrelated-outcome recovery or the host Mission Control UI.

## Infrastructure boundary

- Project: `PinGo Guest Journey Lab` / `10619a4a-d72c-4997-b08d-4bad1b0fe60b`.
- Environment: `guest-journey-test` / `437014cf-52bf-4c3c-a92a-e1738d01d712`.
- Database: independent `Postgres`, database and user `guest_journey_lab`; private networking only.
- API: role `api`, read-only health and evidence endpoints. No product mutation routes.
- Communications worker: role `communications`, invokes only the scoped E7 cycle with injected simulators.
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
