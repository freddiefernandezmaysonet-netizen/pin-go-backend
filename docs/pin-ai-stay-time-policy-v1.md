# Early check-in and late checkout: policy foundation

## Confirmed product direction

Each property configures early check-in and late checkout independently. Each
service has an enabled switch, a local-time limit and a FREE, FIXED or PER_HOUR
fee. PER_HOUR is now automatic, replacing the draft's manual hourly amount:
first booked night for early check-in, last booked night for late checkout, from
the persisted nightly rate snapshot (not today's calendar price, taxes or total
reservation amount). Divide that night by the nominal local overnight duration:
15:00→11:00 is 20 hours, 16:00→11:00 is 19 hours. Calculate the fee directly as
nightly cents × additional elapsed minutes / standard minutes, rounding once
half-up to the nearest whole USD at the end ($10.20 → $10; $10.50 → $11;
$100 / 19 × 2 → $11). Do not round an intermediate hourly price or subtotal
to cents first. Totals below $0.50 round to zero. Fixed fees retain their configured
cents; taxes are applied afterward under the existing tax rules. FREE and PER_HOUR
store amountMinor=0; only FIXED accepts a manual amount. Missing/ambiguous nightly
rates fail closed; an explicitly zero-priced night yields zero. A fixed fee is
charged once per adjustment. Repeated adjustments of the same kind are deferred
until incremental pricing is defined.

This foundation matches the existing modification engine's initial scope:
ACTIVE, PAID Direct Booking reservations. OTA payment ownership and operational
time overrides require a separate integration decision. It cannot approve an
OTA change through the Direct Booking payment engine.

## Audit at main 57da92aaafb0ec4f8d89a08818266f3ad98f6072

### Internal guest consent adapter

`createStayTimeProposal` stores an existing PinAIActionProposal with exact stay-time
terms, bilingual consent, hashed confirmation token and a maximum 60-second expiry.
Creation revalidates inside the generic proposal service's serializable transaction.
`confirmStayTimeProposal` requires the guest and proposal tokens and revalidates
settings, reservation state, nightly basis, taxes, fee split, occupancy and cleaner
completion before recording consent. Generic confirmation without the stay-time
validator is rejected. Repeated confirmation returns the original consent without
executing an action. Price or operational changes require a new quote.

These internal adapters are not mounted to guest routes or runtime tools. Consent
does not hold availability, charge money, modify a reservation or authorize access.
Payment/apply must perform another fresh validation and atomically reserve the
interval before this is exposed as an executable guest flow.

### Internal canonical modification handoff

`stageStayTimeModification` authenticates the guest, locks reservation and proposal,
requires confirmed unexpired consent, verifies the stored proposal fingerprint,
and revalidates all quoted terms inside a serializable transaction. A deterministic
per-proposal request key makes duplicate/concurrent handoffs return one record.
The record preserves guests, amenities, nightly charges and cleaning fees while
adding the stay-time service/tax breakdown and existing incremental fee split.

Paid records start AWAITING_PAYMENT; zero-cost records start APPLYING. The paid
window ends at the earliest of one hour, proposed early arrival/original checkout,
or guest-token expiry, and requires over 31 minutes remaining for Stripe Checkout
setup (provider minimum is 30 minutes). These records participate in existing
reservation-modification interval holds. That hold alone does not reserve the
additional cleaning buffer; a full turnover hold integration is still required.

No Stripe session, payment, reservation date change, access update, or message is
performed by this adapter. It is not exposed by a route/tool. Paid checkout/apply
operation gates still reject EARLY_CHECKIN/LATE_CHECKOUT. In particular,
APPLYING here is a staged state, not proof of an applied change. The remaining
integration must handle holds/expiry and post-payment failures, revalidate before
apply, and durably reconcile both access and cleaning even without cleaner NFC.

### Free canonical apply

The existing canonical apply service now accepts zero-cost stay-time adjustments
only after validating the persisted proposal, its fingerprint, exact pricing and
guest/amenity preservation. It requotes inside its serializable transaction and
checks the complete turnover interval. Only its own scoped APPLYING record is
excluded from pending-hold/readiness checks. Late checkout may apply IN_STAY;
early check-in still requires current cleaner completion and a future arrival.

Reservation dates/pricing and APPLIED status commit together. Existing reconciliation
snapshots retain the old dates so the reconciler can detect the change. Replays
do not reapply the mutation but retry the existing reconciliation call. Tests stub
this call: no hardware or messaging behavior is certified by these database tests.
Business validation failures cancel zero-cost staging and release its hold;
transient transaction failures remain retryable. Paid terms remain rejected.

These changes are internal/unmounted. Durable cleaning-buffer protection against
future bookings, paid checkout/apply, access/NFC start-time correctness, and cleaner
rescheduling without NFC must be completed before rollout. No claim is made that
a committed reservation-time change alone establishes working physical access.

- `pin-go-eligibility-checks.ts` currently treats a `CleaningConfirmation` with
  status `CONFIRMED` for the arriving reservation as early-arrival readiness.
  That is acceptance of a cleaning assignment, not proof of completed turnover.
- `CleaningWork.completionConfirmedAt` records the cleaner's declaration of
  completion. `cleaning-work-completion.prisma.ts` explicitly states this does
  not independently declare the property ready for the next guest. A canonical
  arrival-readiness resolver must associate the right turnover with the arriving
  stay, reject stale/superseded/cancelled work and intervening occupancy, and
  establish readiness under the host's policy. Neither acceptance nor an
  arbitrary completion record is sufficient on its own.
- Existing late-checkout eligibility omits `cleaningStartOffsetMinutes`.
  The actual cleaning window includes offset plus duration.
- The existing `EXTEND_CHECKOUT_ONLY` operation requires a later local date and
  applies the property's standard checkout time. Same-day timing adjustments
  need a distinct operation and fee calculation, preserving nightly prices.
- `reservation.reconcile.service.ts` can reconfirm cleaning whenever either
  arrival or departure changes and `cleaningNfcEnabled` is true. Early arrival
  must not accidentally recreate post-departure cleaning; late departure must
  reschedule actual work even for properties without cleaner NFC.

## Implemented boundary

`planStayTimeAdjustment` is a pure server-side policy function. It accepts scoped,
fresh canonical evidence, validates local-day limits and the requested direction,
checks coverage of reservations/blocks/payment holds, and produces a fee
subtotal. It never grants authorization, creates a proposal, charges, changes a
reservation, modifies access, or sends a message. Runtime uses it only through
the read-only estimator described below.

Early arrival requires a canonical `READY` decision tied to the exact arriving
reservation and scheduled arrival instant. The readiness adapter described below
uses the existing cleaner completion without another host confirmation. Late departure reserves the additional occupied interval and the
entire offset-plus-cleaning interval. Evidence is at most 60 seconds old, and
future-dated evidence is rejected. Evidence freshness is not a concurrency lock:
the executor must re-read under the canonical transaction before confirmation and
again before apply.

Input instants are resolved by the future server adapter using the property
timezone. They must be minute-aligned; ambiguous/nonexistent local times must be
handled by that adapter before offering a proposal. This function compares local
calendar dates and host limits and charges real elapsed minutes, including DST.
Fees use integer minor units and BigInt intermediate arithmetic. The result is a
subtotal, never a final payment amount: taxes and platform/host split still belong
to the canonical pricing/payment layer.

## Property settings implemented

The additive migration adds nullable `Property.stayTimeSettings` JSON and
`stayTimeSettingsRevision` (default zero). An unconfigured property reads as both
services disabled without writing a row. This is preference storage only;
`executionAvailable` remains false in every response.

`GET` and `PUT /api/dashboard/properties/:propertyId/stay-time-settings` use
session-bound authentication and the existing ORG_ADMIN/ADMIN/PLATFORM_ADMIN
roles, always scoped to the actor's own organization and an active property.
PUT requires a complete strict settings object plus `expectedRevision`. The
atomic update checks organization, status, revision, standard hours and timezone,
then increments the revision. Conflicts return 409 instead of overwriting another
session's changes. Enabled limits must extend the standard hours, and enabling
requires a valid property timezone. Settings cannot update reservation data.

The initial currency is USD, matching the existing Direct Booking pricing engine.
The Dashboard companion provides English/Spanish labels, fixed/hourly/free prices,
exact decimal-to-cent conversion, local-time limits, independent toggles, and
explicit reload after a conflict. The panel says automatic guest requests are not
yet available. Its branch disables Vercel deployment; main's settings are retained.
Backend migration/API must precede the Dashboard rollout when authorized.

## Remaining integration work

`prepareStayTimeQuote` is an internal read-only financial quote builder, not a
confirmable proposal. It authenticates the guest token and reads the estimate,
readiness, reservation pricing and active property tax percentages in the same
repeatable-read snapshot. It retains the original pricing snapshot verbatim,
adds taxes only on the additional time fee (same configured percentage-tax model
as Direct Booking), and uses the existing incremental Connect fee calculator.
No extra identity fee is added. The fingerprint binds reservation state, settings,
nightly basis, exact times, readiness evidence, tax configuration and the financial
split. Expiry is at most 60 seconds and bounded by token/stay/request timing.
No proposal, hold, checkout or payment is created; confirmationAvailable remains
false. Guest runtime continues to expose the pre-tax estimate until the full
proposal/confirmation/payment/apply path is connected. Internal cleaner evidence
identifiers are excluded from the guest tool response.

The read-only `estimateStayTimeAdjustment` adapter now obtains the reservation,
property settings, active reservations, host blocks, applied change history and
pending modification holds from one repeatable-read PostgreSQL snapshot. Holds
include PAYMENT_PROCESSING, APPLYING and unexpired AWAITING_PAYMENT, regardless
of the conflicting reservation's payment state. An in-flight change on the same
reservation blocks another estimate. The adapter resolves local clock times and
rejects DST gaps/folds rather than silently selecting an instant. It returns a
minute-prorated fee subtotal, snapshot versions, a 60-second expiry and explicit
`ESTIMATE_ONLY`/no-hold/no-execution flags. It does not create a quote or call a
provider. Availability still needs transactional revalidation at confirm/apply.

The read-tool executor now routes `check_early_checkin` and `check_late_checkout`
through this adapter, using only the gateway-authenticated request context for
tenant/property/reservation scope and the server clock for time. Model arguments
are restricted to `requestedLocalTime`. Missing transaction support and provider
failures return unavailable; they never fall back to legacy eligibility. Estimates
include ES/EN text stating that taxes are excluded and confirmation is not yet
available. No Saved Agent update or deployment is part of this change.

Early arrival uses `readArrivalCleaningReadiness` in the same database snapshot.
The product rule is that the cleaner's `I finished cleaning` confirmation is the
operational completion evidence; no second host approval or new mode is added.
The resolver links exactly one current CleaningWork to the latest departing stay
on the same property, validates its original confirmation/active staff assignment,
consent/start/completion order, and checkout-plus-offset schedule. Cancelled,
superseded, future-dated, ambiguous and schedule-stale work is rejected. Occupancy,
host blocks and pending changes since completion invalidate readiness. It never
uses the arriving guest's post-departure work. A missing prior turnover remains
unknown rather than inventing readiness. The result is freshly assessed against
the arriving reservation/check-in and does not assert physical inspection or
working hardware. Availability, host hours, pricing, consent and access execution
remain independent gates. Missing evidence returns ARRIVAL_READINESS_REQUIRED.
The old early/late eligibility methods remain unused by the read-tool executor. PostgreSQL
tests exercise the actual conflict predicates, including offset-only conflicts,
exact interval boundaries, expired/processing/applying holds, same-stay changes,
tenant scoping, disabled/invalid settings and repeated adjustments.

1. Bind the read-only readiness evidence to proposal confirmation/apply with
   fresh transactional revalidation; handle properties with no prior turnover
   evidence through an explicitly defined operational flow.
2. Add distinct runtime/proposal operations. Bind policy version, exact times,
   readiness evidence, final fee/tax/split, scope and consent to the proposal.
3. Recheck policy and availability under concurrency control at confirm/apply;
   retain guest confirmation, payment idempotency and recovery after paid failure.
4. Add durable reconciliation for guest passcode/NFC timing and cleaner schedule,
   with worker retry and operational truth. Date persistence alone cannot certify
   physical access synchronization. Preserve staff language preferences.
5. Run connected database, UI, payment and access certification before activation.

The additive migration is versioned for isolated CI; no persistent Pin&Go database
has been migrated. No production activation, live provider call or change to the
deployed eligibility tools is part of this work. Production behavior remains
unchanged until the migration and runtime integration are deployed when authorized.

### Atomic Direct Booking ingestion candidate

Direct Booking now rechecks availability through the transaction client immediately before the reservation upsert, after resolving its persisted identity. The check uses the normalized property-local arrival/departure, including persisted pending/applied late-checkout turnover protection. A same-dates active replay does not acquire new occupancy; cancellation releases occupancy and keeps its existing path. Changed dates exclude only the same reservation from the occupancy query.

Only DIRECT_BOOKING ingest runs at Serializable isolation, retrying the complete database callback at most three times for PostgreSQL serialization/deadlock errors. Domain/constraint failures are not retried. Post-commit reconciliation, cleaner confirmation dispatch, guest agreements and messages remain outside the retry loop. Other ingest sources retain their original isolation/behavior.

The disposable PostgreSQL suite exercises the canonical stageStayTimeModification against this exact Direct Booking transaction/check: both readers finish before the first writer commits, with each commit order tested. An arrival one minute before turnover completion must not coexist with the applying hold. These tests do not certify OTA ingestion, legacy creation routes, real Stripe charge/refund recovery, or the full runtime/worker rollout. Those remain separate audit/certification work; keep the PR Draft and execution unmounted.

### Manual creation and host date-change candidate

MANUAL ingest now uses the same serializable transaction/availability check and bounded database-only retries as Direct Booking. The dashboard creation route translates an occupancy/hold/turnover/block conflict into HTTP 409 instead of an internal error. OTA ingestion remains unchanged.

Host date-change preview consults the shared availability reader (including pending modification and persisted turnover intervals), and confirmation rechecks it inside a serializable transaction before its id/version compare-and-swap. The write also fences active status, original manual source and organization. Canonical pricing and host-reviewed version/amount remain required; transactional Channex intent is rolled back with the write, and reconciliation remains outside retries.

PostgreSQL tests now exercise both commit orders for MANUAL ingest versus canonical Pin AI staging. Canonical host date-change tests reject arrival during persisted turnover, retain availability exactly at turnover completion, and reject a block committed after preparation but before the transactional recheck with no reservation mutation or reconciliation. They do not yet exhaust all concurrent manual date-change/PMS/legacy-writer cases or certify production rollout.

### Channex preservation and transactional conflict escalation

The canonical Channex booking lifecycle uses ingestReservation. Its trusted externalProvider=CHANNEX now selects serializable ingestion independently of the OTA source label. It never uses the local booking rejection guard. After the upsert, the same transaction checks availability excluding only the incoming reservation and persists any conflict as a critical HOST/ACTION_REQUIRED operational issue with immutable conflict context. The OTA booking and escalation commit together; ordinary transient database failure remains retryable through existing Channex intake, not a business rejection of the confirmed booking.

When OTA commits first, canonical Pin AI staging must retry/revalidate and reject an incompatible local adjustment. When Pin AI stages first, OTA still persists and records the conflicting promise for host review. Neither reservation is cancelled, a previously applied adjustment is not reverted, and no charge/refund/provider or email operation is introduced. This candidate escalates through operational state/Mission Control, not a new host email. Evidence is keyed by incoming revision, stay window and detected conflict; identical replays neither duplicate transitions nor reopen host-resolved evidence. It records the first availability conflict, not an exhaustive pairwise report. Host resolution/reopening UX, full end-to-end inbox visibility and production rollout are not certified by this database foundation.

### Host conflict review and closure

The companion Dashboard Draft now exposes Review conflict, recorded incoming/conflicting intervals, property-local times, scoped reservation links, current availability and canonical history. Organization administrators can close an alert with an expected issue version and a nonempty outcome. Closure records HOST_REPORTED_RESOLVED with the actor and one manual transition; it does not independently verify resolution or change any reservation, cleaning work, payment or provider state. Exact replays are idempotent and different outcomes cannot overwrite a closure. Recent closed OTA alerts retain review access. No production activation is claimed.

### Internal guest consent-to-execution bridge

prepareStayTimeGuestAction projects only guest-facing dates, totals, expiry and consent; the one-time confirmation secret is returned separately for future interface transport, never in the model-visible public result. Immutable cleaning evidence, tenant identifiers and original pricing snapshots remain internal. Unsupported identity/payment/redirect fields are rejected.

confirmAndExecuteStayTimeGuestAction confirms the scoped proposal and stages the same canonical modification before branching. Free adjustments apply through the canonical service and can retry reconciliation without creating another change. Paid adjustments use an injected server-owned Checkout adapter; they return a vetted payment URL and local hold status without applying or claiming a payment. A provider outage retains the confirmed/staged change for idempotent retry. A payment event that wins during Checkout preparation is recognized through persisted APPLIED state and canonical reconciliation. Missing providers, terminal states and unsafe URLs fail closed.

The bridge is deliberately not registered with guest runtime, routes, the Saved Agent or workers. Disposable tests exercise real consent/staging/free application with fake Checkout and reconciliation callbacks. The signed Stripe webhook now routes stored stay-time modifications through the account-scoped payment processor for both Checkout completion event types. It checks the signed event account against the stored account and session before processing, waits for paid status, and leaves provider errors or pending refunds retryable in the existing financial-event ledger. General date-change payments retain their existing handler. Offline signature and PostgreSQL tests cover application, replay and recovery; this is not live-provider certification. Guest transport and durable retry-worker composition, followed by authorized provider/hardware certification, remain rollout gates. The public stay-time tools still return estimates only; executionAvailable remains false there.

The webhook integration was published as `fb5cccd0365ba96d7d0c9ad0598245db5f2dd6af` with the same tree as local `f24e7a45`: all 45 workflows and 433 focused tests passed, with no failures or skips. Provider interactions remain simulated.

The follow-up adds the actual Stripe webhook entry point to the settings TypeScript gate. It fixes the four pre-existing errors exposed by that broader import graph: cancellation rules retain their inferred mapped type; Direct Booking initial notifications, subjects and retry payloads use the stable reservation id when the public number is absent; and Stripe-reported dispute closure uses the schema-supported AUTOMATIC resolution type while preserving the Stripe event and closure code. No reservation number is generated or overwritten. The webhook import graph now compiles locally under strict settings; this does not certify the whole backend or production. Durable retry-worker composition and guest transport remain pending.
