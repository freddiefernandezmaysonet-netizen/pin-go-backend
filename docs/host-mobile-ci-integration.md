# Host operations cross-module certification

PR472 adds the Host device registry to the existing native incident/reply package. Its additive schema change triggers sales and Airbnb workflows whose scope gates were written for earlier, narrower projects. At a9557b8 those gates failed before their runtime tests ran; the Host foundation suite itself passed.

The four workflows now recognize this exact PR/repository/branch/base combination through scripts/verify-host-mobile-operations-scope.mjs. The verifier requires the complete explicit file list, the pinned base 69434d924208153a444ef5716e7c414380dff899 and its ancestry. Removing the exact two Host models and user relation block must restore the entire base schema byte for byte. Sales/OTA implementation files are not allowed. A changed base or additional scope requires fresh review; the verifier fails closed.

Only the obsolete project-specific scope gate gains a Host branch. All later sales/Airbnb type checks, database suites, fingerprint checks, transport tests and bundle steps remain. For the two migration certifications, disposable databases start from the unchanged base schema and apply the actual Host registry migration, then check full schema parity and the retained sales sentinel/contracts. They do not replay already-integrated sales migrations.

The verifier's negative tests cover wrong PR/fork/branch/base, extra and missing files, altered existing sales/OTA/user schema, changed Host models and duplicate/missing relations. These checks supplement rather than replace runtime certification. A successful scope check alone is not integration or release approval.

No production database, worker, flag, provider, guest message, store build or deployment is changed. Push permission, delivery, preference UI and physical-device validation remain separate incomplete work.
