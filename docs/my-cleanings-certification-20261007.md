# Mis limpiezas — certification evidence

## Candidate and release boundary

- Backend Draft PR: https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/pull/376
- Dashboard Draft PR: https://github.com/freddiefernandezmaysonet-netizen/pin-go-dashboard/pull/198
- Certified Backend remote SHA: `fa4ace51b29e5b2f1633f0173cabfaa7ca85e0d7`.
- Certified Backend tree: `344c49d0334fb311de1f533eaa7012191bd3f809`.
- Integrated Backend main: `ba9cd60ea3a1365dd155e3d438043e84dd61e716`.
- Integrated Dashboard head: `a29315e3e1f0691896d0f22f4fe11131f38b3047`.

No merge, production migration, deployment, SMS or physical provider command is authorized by this certification. Provider commands in tests are injected fakes.

## Passed GitHub checks

| Check | Exact run | Evidence |
| --- | --- | --- |
| My Cleanings Native Certification | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704368021 | PostgreSQL 16; 41 persisted/concurrent tests and 21 authorization/recovery tests; zero failures/skips |
| Cleaning Follow-up V1 Foundation | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704367972 | Both foundation and native snapshot/concurrency jobs passed |
| Cleaning Completion Mobile Responses | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704367538 | Mobile response and extracted renderer contracts passed |
| Cleaner access window | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704367874 | Existing access-window certification passed |
| Cleaning Timing Property Timezone | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704367784 | Existing timezone certification passed |
| Pin AI Guest Gateway V1 | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/actions/runs/37704367447 | Gateway integration passed after standalone Prisma repair |

Native migration checks use the recorded pre-feature schema, apply added migration files in order, and verify that an existing synthetic StaffMember retains its card reference without obtaining a dashboard account automatically. This is a disposable migration rehearsal, not a production migration.

The persisted suite covers work/access independence, task ownership, checklist snapshots, pagination, cancellation before the canonical window, backup acceptance, recovery rediscovery and receipt safety. Two independent Prisma clients proved simultaneous extension requests share one intent/one provider attempt and expiry does not retire an extension in flight. Interrupted/ambiguous commands require review without another hardware attempt. Recovery policy tests cover restarting traversal from durable rows after a failed scan.

## Cross-feature CI failures inspected

These checks remain failures; do not describe the whole PR as green or Ready.

- Channex Host Inbox, Airbnb Access and Messages Installation strict typechecks reported unchecked array entries in cleaner access-window and confirmation pagination. Follow-up correction checks the selected entries explicitly, preserving access calculations and batch size. The same local strict typecheck then reports only two existing errors in `src/lib/auth.ts` (`expiresIn` optional type and optional `role`). That file has no diff against the integrated main. No authentication behavior or compiler strictness was changed to hide the errors.
- Authentication E5–E8B safety steps prohibit migrations or require an authentication-only PR file allowlist. Cleaner migrations fail that boundary even though the corresponding runtime contracts/typechecks passed. These are inspected scope-gate failures, not certified-away security failures. They still need an appropriate reviewed CI scope decision.
- E15 Access Ambiguity and APMS Exit Closure prohibit any Prisma schema/migration/package diff. Their runtime regressions, structural checks and bundles passed, then the schema/migration boundary rejected the cleaner changes.
- Airbnb Listing Discovery's whole-PR allowlist rejects `.github/workflows/my-cleanings-native-certification.yml` before running its later checks. Do not infer those skipped checks passed.

Do not remove cleaner migrations, widen all allowlists or disable unrelated certification to obtain a green badge. Retain the exact failures and give any CI correction its own reviewable rationale.

## Remaining completion checklist

- [x] Durable recovery traversal and restart/failure rediscovery verified.
- [x] Main integration and current Pin AI activation/terms controls verified.
- [x] Additive migration rehearsal and native concurrent cleaning certification.
- [x] Existing cleaner access-window, timezone, follow-up and mobile response CI.
- [ ] Resolve strict inherited authentication type errors and reviewed cross-feature CI applicability.
- [ ] Actual browser visual review of cleaner views and host controls at mobile widths; React/runtime and response tests alone do not establish this.
- [ ] Real primary/backup NFC and phone evidence: two-hour programming horizon, future start enforcement, access expiry independent of explicit work completion.
- [ ] Separate concrete authorization for merge and production release.

No new cleaner message family or change to live Twilio transports is introduced by this checkpoint. Already ENDED access is not automatically reopened; it remains a host-review case.
