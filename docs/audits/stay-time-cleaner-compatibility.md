# Local compatibility candidate: stay-time and cleaner access

Prepared 2026-10-04. Not published, deployed, or physically certified.

## Inputs and scope

- Base: PR #333, `151619ab1fbd27b14736770c781fea8fce02f5d8`.
- Cleaner implementation: PR #353 commit `f6d2eed`, included in reviewed head
  `ba8b5f4b6353fae0743c87e16f8042ae2cc428e1`.
- Local branch: `local/stay-time-cleaner-compatibility`.
- The two subsequent PR #353 CI allowlist commits are not transplanted. This is
  a source compatibility candidate, not a merge of all current main changes or
  a publish-ready CI scope certification. Existing remote PRs are unchanged.

## Resolution

The reconciler retains PR #333's guest start/end synchronization, durable failure
markers, and atomic cleaner-confirmation renewal. It uses PR #353's property-clock
and next-arrival calculation for cleaner access, including other reservations on
the property. The legacy property duration is no longer used by the reconciliation
planner to determine access expiry. Its existing renewal snapshot comparison is
retained; it does not calculate access duration.

The plan distinguishes the accepted cleaning start from access expiry:

- Changed departure or a changed live cleaner start requires renewed consent.
- A changed access end alone reschedules access without expiring cleaner consent.
- Early arrival alone leaves that reservation's post-departure cleaning intact.
- An earlier arriving guest caps the preceding reservation's cleaner access.
- Missing/failed provider synchronization cannot acknowledge a new physical period.

Staff duration commitments remain in stay-time eligibility and pricing evidence;
this integration does not replace them with the access allowance.

The dashboard property-route import conflict was resolved by keeping the cleaner
reconciliation import without importing an unrelated main-only arrival-location
helper. No unrelated main feature was transplanted.

## Local validation

Both the complete stay-time TypeScript configuration and the affected cleaner
access dependency graph compile. The focused offline suite passed 73 tests,
zero failures or skips, across cleaner access policy/provisioning/property
reconciliation, guest access, cancellation, cleaner reconfirmation and committed
cleaner duration. Provider/database adapters in these focused cases are simulated.
No PostgreSQL integration suite was run for this combined candidate.

No GitHub Actions run, remote publication, infrastructure creation, migration,
provider call, payment, message dispatch or flag activation was performed.

## Before publication or deployment

Review the final combined diff against the then-current main and both PR heads.
Resolve exact CI scope manifests as part of one bounded publication plan; do not
disable existing guards. Publication, CI consumption and deployment still require
the user's specific approval. Existing CI results for each separate PR do not
certify this combined tree. Connected migration, payment and physical access
acceptance remains pending.
