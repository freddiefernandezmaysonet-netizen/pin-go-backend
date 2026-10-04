# Local compatibility candidate: stay-time and cleaner access

Updated 2026-10-04. Final integration remains local; no deployment or physical certification.

## Bounded database validation and current-main integration

The user authorized one validation-only branch publication and one Linux job,
with a 15-minute timeout and no retries. Remote commit
`bb8a2620a8e771a8408d5146d9e568a966baec60` passed all 662 tests with zero
failures/skips in run 37207534598 (job 111451761669), attempt 1. The single
job ran for 131 seconds. This is execution time, not a billing statement.
Its source parent tree matches local compatibility commit `1973450` exactly.

The final local integration now merges main
`bcfc72e526e438d6cb3fc99f4c1a268f53b81011`. The only textual conflict was the
property-route imports; both cleaner reconciliation and arrival-location parsing
are retained. Main's incident-language and arrival-location changes are preserved.
Both affected TypeScript compilations pass, and 85 focused offline tests pass
with zero failures/skips. The 662-test database result predates this main merge;
it must not be reported as a database run on this final candidate.

The two PR #333 scope manifests enumerate the combined 135-path diff. The
schema fingerprint includes only main's two additional property arrival-location
fields alongside the previously reviewed recovery changes. Existing runtime
certifications, migration hashes and repository/PR checks remain enabled.
The one-shot validation workflow is not included in this integration branch.
PR #353's separate CI allowlists are not transplanted.

Remote PRs #333, #353 and dashboard #177 remain unchanged and Draft. Further
publication/CI, merge, deployment and connected canary still require specific
authorization. The sections below describe the original pre-validation candidate.

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
