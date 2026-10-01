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

## Remaining integration work

1. Add property persistence, versioned policy updates, authorized host API and
   English/Spanish settings UI. Default both services to disabled.
2. Build the canonical arrival-readiness adapter and complete availability queries
   (including pending holds) without confusing the departing and arriving stay.
3. Add distinct runtime/proposal operations. Bind policy version, exact times,
   readiness evidence, final fee/tax/split, scope and consent to the proposal.
4. Recheck policy and availability under concurrency control at confirm/apply;
   retain guest confirmation, payment idempotency and recovery after paid failure.
5. Add durable reconciliation for guest passcode/NFC timing and cleaner schedule,
   with worker retry and operational truth. Date persistence alone cannot certify
   physical access synchronization. Preserve staff language preferences.
6. Run connected database, UI, payment and access certification before activation.

No schema migration, production activation, live provider call or change to the
existing eligibility tools is part of this foundation. The two audited live
eligibility limitations therefore remain open until the adapter integration.
