# Channex guest registration exemption — draft

Baseline: `main` at `2a8dc3abcfa33a8b6f6a3b3f30ea7e1a0d1e50d3`.

The user confirmed that imported Channex bookings must receive access like the historical Lodgify flow, without the Direct Booking identity/registration/agreements prerequisite. The parent of `3c140f8b` (secure guest access, July 14, 2026) contains the historical worker payment gate and TTLock activation without registration checks. Payment, active-reservation, scheduling, cancellation and actual secure grant evidence remain required; no claim is made that every historical behavior should be restored.

## Changes

- Recognize persisted `externalProvider=CHANNEX` plus a nonblank external booking id. A channel name in `source` alone never grants exemption. Other providers keep their existing behavior.
- Evaluate access for both new and existing Channex rows without requiring identity, agreement snapshot/signature/acceptance or property-rules acceptance. Old inherited snapshots and verification statuses do not override channel policy.
- Skip property agreement capture and Stripe Identity creation for these bookings. Reject old form submissions before any guest identity or agreement writes; validated links redirect to the existing guest access portal.
- New legacy journeys remain confirmed until real access release. Existing confirmed/verification-pending journeys can schedule only after persisted released passcode evidence. The compare-and-set audit preserves the actual previous state and Direct Booking audit id format.
- Enterprise reconciliation treats the registration stage as satisfied by exemption, with no invented identity verification timestamp, signature, acceptance or consent. Existing compliance work completes with an explicit exemption outcome.
- Omit verification links/reminders for Channex; suppress queued identity reminders in legacy SMS and Enterprise delivery. Existing Channex rows do not consume the legacy registration-reminder batch.

## Validation

138 local tests passed (including the unchanged certified-core freeze test): persisted provenance, access blockers, old snapshots, Direct Booking regressions, HTTP GET/POST on loopback with fake data, journey transitions/idempotency, reconciliation without invented timestamps, compliance owner and communications. No real guest, provider or database was used.

Strict TypeScript and emitted build now pass for the complete affected boundary, including the reservation worker. Four pre-existing errors were independently reproduced on the untouched baseline and then fixed:

- Cleaning follow-up reconciliation selects the existing MessageLog.deliveredAt field and falls back to the reconciliation observation time when SENT has no provider-delivery timestamp. It does not use the original failed message creation time as delivery evidence.
- Passcode resynchronization skips and logs a grant with no reservation before dereferencing its dates.

The new policy/tests use the guest-registration-channel domain naming. Initial Channex-prefixed names accidentally entered the certified-core file selector; the names were corrected. The original 125 core files and SHA-256 remain unchanged, and the original guard passes without edits.

Three cleaning delivery tests cover provider timestamp, fallback timestamp and absence of SENT evidence. No existing CI allowlist or certified Channex-core fingerprint is relaxed. This focused build is not a claim that every unrelated repository project compiles.

## Release gate

Draft only. Run CI on the final candidate before controlled deployment; the local worker build blockers are resolved. API and workers are separate services and both need the code release. Then verify a real Channex reservation without guest registration, a Direct Booking control, and normal expiry/cancellation behavior. No migration or bulk rewriting of historical identity/agreements is needed for this policy.

No merge, deployment, variables, database data or live access changes were performed. Existing provider sessions and historical messages already sent are not erased.
