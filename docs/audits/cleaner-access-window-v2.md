# Cleaner access window correction

Base: main e4349d399571735f99bcc606eadd749c76ae0a81. Prepared offline; no production changes.

## Agreed rule

The default access duration is property check-in minus property check-out minus 60 minutes.
The 60 minutes include the start offset. Staff cleaning commitments remain separate inputs
for early check-in / late checkout eligibility.

Start = effective reservation checkout + property offset.
End = earliest of start + default duration, standard property check-in on departure day,
and the next noncancelled reservation check-in (including overlapping arrivals).
An empty or invalid window is rejected. A next reservation several days away does not
extend the normal access allowance. Times are interpreted in the property timezone.

Casa Collores: 12:00 checkout, 16:00 check-in, 45-minute offset => 12:45–15:45.
The screenshot and production log previously showed 12:45–16:45 on 2026-10-27.

## Changed paths

A shared policy and occupancy reader now drive the cleaner autopilot, NFC assignment,
reconciliation, readiness audit and scheduled/retry provisioning. Provisioning rereads
occupancy and sends the derived period to TTLock before persisting ACTIVE. The audit
rejects mismatched periods even when an NFC record has SCHEDULED/ACTIVE status.
Reconciliation updates scheduled periods, updates active hardware before acknowledging
the change, and closes invalid periods; a provisioning claim blocks concurrent reconciliation.
Database read errors do not authorize revocation.

The old Property.cleaningDurationMinutes field and old settings UI are not migrated in
this patch: the legacy UI uses 180/240 as a check-in selector, so replacing those payload
values would change the selected arrival hour. Compatibility is preserved. These access paths no longer use that field. No Staff commitment is changed.
Unmounted legacy routes/helpers are not activated or rewritten.

## Validation and rollout limits

65 focused offline tests passed, including real provisioning service calls with an injected
fake provider. The affected TypeScript dependency graph, including both property routes, compiles with strictNullChecks enabled. The earlier baseline diagnostics were resolved with type-only corrections: optional season type, retained engine type in recommendation maps, an explicit saved-rate array type, and the existing mailer's nullable reservation number contract. The three Channex narrowing diagnostics disappeared with strict null checking; no Channex source or freeze fingerprints changed. The certified-core freeze test passes. Hardware behavior has
not been certified. The production reservation has not been repaired.

Before rollout:
- Review compatibility with Draft PR #333, which also changes reconciliation. Do not
  overwrite or merge that branch implicitly.
- Audit and reconcile existing scheduled/active cleaner assignments against the shared
  calculation. Do not claim database edits alone update a programmed physical card.
- Event-driven cross-reservation reconciliation is connected to reservation reconciliation,
  the existing complete-flow audit and both property-settings write routes. Test the full
  connected Direct Booking, manual and Channex entry points before production: the current
  tests use injected provider/database doubles, not live mutations. A property write that
  succeeds but cannot repair access returns 409 with propertySaved=true. Provider failures
  preserve the previous hardware receipt and report an error; this is not a guarantee of
  physical revocation during outages. No continuous polling of ACTIVE guest cards is added.
- Keep strict null checking and the existing certified Channex guards enabled in CI.
- Verify physical expiration, operator escalation for no-window cases, and provider failure
  recovery in a controlled canary before broader activation.
