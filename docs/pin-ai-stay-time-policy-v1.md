# Early check-in and late checkout: policy foundation

## Confirmed product direction

Each property configures early check-in and late checkout independently. Each
service has an enabled switch, a local-time limit and a FREE, FIXED or PER_HOUR
fee. Hourly fees in this implementation are prorated by actual elapsed minutes,
rounded once half-up to the currency's minor unit. This rounding choice is an
implementation decision; the host and guest UI must disclose it. A fixed fee is
charged once per adjustment. Repeated adjustments of the same kind are deferred
until incremental pricing is defined.

This foundation matches the existing modification engine's initial scope:
ACTIVE, PAID Direct Booking reservations. OTA payment ownership and operational
time overrides require a separate integration decision. It cannot approve an
OTA change through the Direct Booking payment engine.

## Audit at main 57da92aaafb0ec4f8d89a08818266f3ad98f6072

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
reservation, modifies access, or sends a message. It is not mounted into runtime.

Early arrival requires a canonical `READY` decision tied to the exact arriving
reservation and scheduled arrival instant. The readiness adapter is not built in
this change. Late departure reserves the additional occupied interval and the
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

This adapter is not mounted into the guest runtime yet. Early arrival deliberately
fails with ARRIVAL_READINESS_REQUIRED: there is no persisted host-readiness
authority to trust, and cleaner acceptance/completion cannot substitute for one.
The existing runtime eligibility tools therefore remain unchanged. PostgreSQL
tests exercise the actual conflict predicates, including offset-only conflicts,
exact interval boundaries, expired/processing/applying holds, same-stay changes,
tenant scoping, disabled/invalid settings and repeated adjustments.

1. Build persisted canonical arrival readiness without confusing the departing
   and arriving stay; bind the new estimator to authenticated runtime context.
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
existing eligibility tools is part of this work. The two audited live
eligibility limitations therefore remain open until the adapter integration.
