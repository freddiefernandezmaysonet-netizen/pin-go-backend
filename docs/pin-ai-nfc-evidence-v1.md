# Pin AI guest NFC evidence V1 — local review

Base audited: backend main ddbd6f0d0defb76b9582f974f42abb386bd75c63.

The guest's quoted answer preceded NFC recovery. At that time both physical
cards were FAILED; it was not a stale answer about already-active cards.
The actual gap is that get_access_status read AccessGrant only and did not
read NfcAssignment or the existing guest NFC activation incidents.

## Scope

Extend the existing read-only tool with reservation/property/organization-scoped
guest-card evidence and only the matching NFC activation incidents. Return
sanitized status, recorded and desired access windows, provider confirmation
timestamp, retry eligibility and whether host attention/recovery is recorded.
Do not expose provider errors, card identifiers, credentials, operational keys,
incident text or unrelated operational incidents. Database failures propagate;
they must not become a fabricated empty-card result. Limit the response to 100
assignments and explicitly report truncation.

Physical cards are distinct from phone NFC. Lock isActive is configuration,
not a connectivity probe. Provider confirmation is not a physical entry test.
An incident does not establish notification delivery. Retry eligibility follows
the existing NFC recovery policy, with earliest timing rather than a guarantee.
Existing grant fields and the tool catalog are retained.

This is the first evidence-reading slice proposed for Reservation Supervisor,
not an autonomous supervisor engine or a new action executor. No TTLock calls,
database writes, schema changes, financial actions or Health Center changes.

## Session impact

The agent instructions change for read-only and action-canary sessions. The
existing runtime configuration fingerprint includes those instructions, so a
previous session rotates on its next eligible turn using the existing bounded
dialogue carryover. Persisted guest conversation history is unchanged. Live model
wording and session continuity still need post-deployment verification.

## Validation

- npm run test:pin-ai-runtime: 198 passed, zero skipped, including 8 new tests.
- Guest Gateway typecheck passed.
- tsc -p tsconfig.pin-ai-nfc-evidence.json: passed.
- Emitted compilation with that scope passed.
- git diff --check passed.
- Existing Guest Gateway CI now runs the new tests and scoped compilation.

These tests mock database reads; no real provider request or production write
was made. This document does not authorize Ready, merge, deployment or variables.
