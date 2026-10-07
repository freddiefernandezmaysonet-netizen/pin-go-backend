# Mis limpiezas — release and general activation

## Current authorized scope

Freddie changed the rollout decision on 2026-10-07: implement for all current and future properties. No single-property canary, organization allowlist or separate rollout switch is required. Serena Studio is included when its staff configuration is enabled. This decision supersedes the earlier property-limited plan.

Implementation and automated verification are authorized. Publication, merge, migration application and deployment remain pending separate authorization. Phone/provider testing will use the existing production environment after the reviewed release is authorized; no new staging infrastructure is requested.

## Current implementation

**Review blockers:** `audits/my-cleanings-review-20261007.md` documents reproduced substitute NFC ownership and 30/30 reminder defects, incomplete access/portal independence, daily pagination, stale reminder retry risks and unfinished recovery. Do not treat passing unit/SQL tests as a completed substitute-access flow or a release certification. Address these findings before deployment.

Reminder clarification from Freddie on 2026-10-07: the existing start reminder is correct at scheduled start plus the configured start-confirmation grace when start is missing. The committed-end requirement applies to completion follow-up. The local changes deferring start reminders to committed end and relabeling their settings were reverted before publication/deployment. Preserve the distinction in further recovery/message work.

NFC clarification from Freddie: primary and backup both remain SCHEDULED after acceptance until the existing two-hour-before-access-start programming horizon. Programming uses the future access window; ACTIVE denotes provider-acknowledged programming, not early physical entry. Preserve this worker behavior and enforce card ownership during reassignment. No start/completion button controls entry.

- Restricted cleaner accounts and own-task dashboard: local commits.
- Guarded start/completion and separate access window: local commits.
- Property template/task checklist and required-item completion guard: local commits.
- Confirmed-task cancellation and sequential backup offer creation: implemented locally; see `cleaning-reassignment-v1.md`.
- Existing NFC readiness now requires the accepting cleaner's own mapped card, with nine new regressions. A mismatch is recorded as failed access verification; transfer/revocation and independent access scheduling remain pending. See the audit's local ownership guard correction.
- Independent access transfer design is documented in `cleaning-access-reassignment-design.md`. The complete-flow audit ownership bypass is corrected locally with ten full-audit runtime regressions. The sync worker now checks current confirmed cleaner/card before and after programming, with 27 cleaner/guest worker regressions. Complete physical transfer, cleanup of already-programmed/uncertain permissions and serialized command authority remain release blockers.
- Unused SCHEDULED grant transfer is implemented locally: verify withdrawn cleaner/card provenance, retire with a conditional update under reservation lock, and schedule the confirmed backup's own card/window. Forty-eight focused regressions pass. ACTIVE/PROVISIONING/previously attempted grants and independent cancellation recovery remain pending.
- Programmed-permission audit confirms original lock/card command provenance is not persisted on the NFC assignment. Early withdrawal requires durable target/recovery evidence and shared programming/withdrawal command authority; natural expiry is not proof of early revocation. The next implementation boundary is documented in the reassignment design. No schema or provider change was made in this audit block.
- Subsequent local provenance implementation adds `CleanerNfcProgrammingAttempt` and migration `20261007090000_cleaner_nfc_programming_attempts`. Exact target/period are stored before cleaner programming; preparation failure prevents sending, and acknowledgement/aborted/uncertain outcomes remain distinct. Fifty-seven focused regressions and disposable SQL migration checks pass. Apply this migration before deploying the changed worker. Historical target recovery, physical withdrawal and shared command authority remain pending.
- Exact-target provider inventory evidence reader is prepared locally, following the official TTLock period/list contracts, with eleven injected-provider regressions and TypeScript validation. It distinguishes reported period from physical verification and is not yet integrated into a withdrawal executor. No account/provider inventory was queried or message sent.
- Integrated recovery contract now explicitly requires the backup's own SCHEDULED intent immediately upon acceptance even when prior physical withdrawal is pending. Current code provides this only for unused-grant replacement; the live-permission case remains a gap. Existing AccessGrant recovery offers a CAS pattern but its fixed multi-hour delays and storage do not directly fit cleaner NFC. Deadline-aware orchestration and all cleaner period writer coordination remain pending; see the design's integrated flow.
- Backup exhaustion is recorded atomically in Mission Control; superseded offer attention closes as replacement progresses. No notification/provider call is added. See `cleaning-backup-exhaustion-v1.md`.
- Pin AI departure-cleaning status distinguishes offer acceptance from explicit start/completion: implemented locally; see `cleaning-pin-ai-status-v1.md`. This is a read prerequisite, not an automated recovery handler.
- Cleaner-declared delay/incomplete recovery, Pin AI access extension, host configurable deadlines and message consolidation: pending.
- Native PostgreSQL concurrent-session certification and phone/provider end-to-end evidence: pending.

## Release acceptance

- [ ] Exact implementation commits/migrations reviewed; compile and relevant regressions pass.
- [ ] User authorizes publication/merge/deployment.
- [ ] Additive migrations verified and applied through the authorized release.
- [ ] Cleaner phone test: primary availability -> cancel before the canonical window starts -> next viable backup -> explicit acceptance and timing consent -> same checklist -> start inside window -> required items -> completion.
- [ ] Stale/expired offer and cancel-at/after-window-start requests reject even without explicit Start; concurrent start/cancel accepts only one transition.
- [ ] Work buttons do not control NFC entry/exit; access expiry never completes work.
- [ ] Existing property outside the original test property uses the new flow when staff is configured.
- [ ] Newly created property uses the flow without adding its ID to any allowlist.
- [ ] No duplicate offer/SMS or new cleaner message family.
- [ ] Remaining approved recovery/message/configuration blocks complete or explicitly deferred with a defined functional scope.
- [ ] Project is marked complete only after release and current/new-property verification.

## User clarification — 2026-10-07, 12:04 Puerto Rico

Acceptance still permits cancellation before the canonical cleaning window starts. At that exact start, cancellation is blocked even when no Start action was recorded. Recorded start/completion also block withdrawal. Local backend validation now re-reads that window under the reservation lock; the dashboard removes cancellation controls when the displayed start arrives, including an open confirmation prompt. Backend time and canonical bounds remain authoritative.

NFC policy: acceptance schedules the cleaner's own grant; programming remains two hours ahead with future entry dates. An unused scheduled grant must be cancelled and excluded from programming on withdrawal. Already-programmed entry may remain until its original expiry; the host explicitly allowed this, so previous requirements for physical withdrawal before backup programming are superseded. Integrated cancellation of unused grants and backup creation alongside an already-programmed former grant remain pending. No hardware behavior was changed in this boundary correction.

Validation: isolated SQL reassignment suite (9 tests, no skips), dashboard runtime test including cancellation prompt crossing the start boundary, backend scoped TypeScript compile and dashboard build passed. Embedded SQL does not certify native PostgreSQL concurrency or real provider/phone behavior. No push, merge or deployment.

## Cancellation closes unused NFC intent — local implementation

Explicit pre-window cancellation now closes the cancelling cleaner's mapped property card grants in the same transaction as work cancellation and the next backup offer. Only CLEANING/SCHEDULED grants with zero retries, no provisioning timestamps and no programming journal entries qualify. They use existing NFC terminal status ENDED plus CLEANER_UNUSED_GRANT_CANCELLED; the corresponding scheduled StaffAssignment becomes CANCELLED. The physical card and its cleaner mapping are retained. The worker's existing compare-and-set claim cannot claim the ended intent from a stale batch.

ACTIVE, PROVISIONING, attempted/journaled grants and GUEST permissions are preserved. Current authority checks continue to reject obsolete programming, while already-programmed access keeps its original expiry. No provider call or message was added. Creating the accepted backup's own grant alongside retained prior ACTIVE permission remains an implementation gap; offering the backup is already transactional.

Validation: isolated SQL reassignment suite verifies unused closure, cancelled staff assignment, retained programmed/inflight/attempted/journaled/guest grants, and the next pending backup. Native PostgreSQL concurrency and physical provider tests remain pending. The programming-journal migration must be applied through an authorized release before this code is deployed.

## Accepted backup alongside cancelled primary ACTIVE permission — local implementation

Access Autopilot can now create the accepted backup's own SCHEDULED grant alongside an explicitly CANCELLED prior cleaner's ACTIVE grant. A reservation row lock protects current-offer validation and duplicate prevention. The helper verifies the former property card mapping, the replacement mapping, the exact former ACTIVE grant, and conflicting replacement-card periods. The former grant is not edited. Repeated scheduling returns the existing own grant only when its dates match. The existing worker retains its two-hour programming horizon and current-cleaner checks.

This closes the specific ACTIVE-prior replacement-intent gap described above. PROVISIONING, uncertain/failed prior attempts and changed historical card mappings remain conservative failures requiring further recovery design; they are not falsely certified as ACTIVE. Historical cloud inventory is not physical verification. Broader timing/message/UI recovery gaps and real provider/native PostgreSQL certification remain pending. No new messages or deployment.

Validation: Access Autopilot/worker/unused-grant tests (45 pass); isolated SQL reassignment suite (9 pass) includes real persisted replacement creation, idempotency, retained prior grant, foreign/current-offer rejection and conflicting card windows; scoped backend TypeScript passes.

## Cancel during former cleaner programming — local follow-up

The replacement helper now also allows an explicitly cancelled former PROVISIONING grant, including a transition to FAILED between the initial snapshot and locked validation. It schedules only the accepted replacement's distinct mapped card, preserves the prior record/journal and does not certify the former physical outcome. Existing worker authority checks prevent obsolete retries and record late provider acknowledgement separately from current ACTIVE assignment evidence. The two-hour horizon is unchanged.

Validation: 32 focused Access Autopilot/worker tests and 9 isolated SQL reassignment tests pass, including retained interrupted prior grants and idempotent backup intent; scoped TypeScript passes. Real provider timeout/late-response behavior, the remaining last-check-to-persistence race, and native PostgreSQL concurrency remain uncertified. These tests do not establish complete recovery of every interrupted programming case. No messages, push, merge or deployment.

## Final cleaner activation receipt serialized with withdrawal

After provider acknowledgement, cleaner activation persistence now takes the same reservation row lock used by cancellation/reassignment, rechecks the exact accepted confirmation/card, and writes the ACTIVE assignment/card receipt in that transaction. Provider commands stay outside the lock. A cancellation that wins the lock prevents a later activation receipt; acknowledgement remains durable even when current authority is gone. Guest persistence retains its existing transaction path.

Focused worker and guest recovery tests (34 pass) include cancellation immediately before the receipt lock; scoped TypeScript passes. This closes the last-authority-check-to-receipt gap for cooperating cancellation/reassignment transactions. It does not certify physical late responses, unrelated card mapping writers or native PostgreSQL concurrent sessions. No deployment.

## Existing cleaner reminder retry audit

See `audits/cleaner-reminder-retries-20261007.md`. Initial reminder delivery suppresses closed work, while generic FAILED SMS retry lacks cleaner work/offer/phase checks. Obsolete retry suppression and stronger exact-message correlation remain required before release. 18 existing timing/receipt tests passed; reminder timings were not changed and no new messages were added.

## Existing reminder retry suppression — local correction

FAILED START_REMINDER and COMPLETION_REMINDER SMS retries now validate the existing action URL's exact token against the sole current CONFIRMED offer, active reservation/property/organization, active staff/recipient, and single consented work record. Closed/superseded work and obsolete phases are retired in message history using existing status `OBSOLETE`; the message is never rewritten for the backup. Missing/ambiguous legacy context is conservatively retired. The existing followup policy determines usefulness; cadence, defaults and SMS bodies are unchanged. Other SMS types bypass the guard.

The retry worker calls the guard immediately before Twilio. Initial delivery's context revalidation and stronger durable message/work correlation remain pending. There remains a short state-check-to-provider-call race; this correction does not promise atomic SMS delivery/cancellation. No SMS was sent during verification and no deployment.

Validation: 11 retry tests, including actual worker function execution with fake provider boundaries, plus 5 timing policy tests passed. Scoped TypeScript passed.

## Initial cleaner reminder delivery scope revalidation — local correction

Initial claimed followup delivery now verifies active reservation/property/staff organization and exact confirmation ownership. After building the existing SMS body, it re-reads the work, sole current offer, active reservation and unchanged active recipient/language immediately before sending. Cancelled/superseded/completed work, recorded Start for a start reminder, pending replacement, changed token/identity and ambiguous offers suppress delivery. SMS wording, language selection and reminder schedules are unchanged.

24 focused initial-delivery/retry/timing tests pass; scoped TypeScript passes. No real SMS was sent. The very short final-read-to-provider-call race remains: these reads are not an atomic transaction with Twilio. Durable exact receipt/message association and grace-equals-duration configuration consistency remain pending. No deployment.

## Routine cleaner SMS reduction — local implementation

Removed the reservation worker's routine CLEANING_READY send at guest checkout, NFC-active cleaning-start SMS and access-ended cleaning-end SMS. Existing availability dispatch, conditional Start/Completion reminders, guest checkout SMS, NFC provisioning and access revocation paths remain wired. Removed only notification blocks/imports and the now-unused routine flag display; the Twilio client, builders and unrelated send services remain unchanged. This applies globally when the authorized release is deployed, without a property allowlist.

Existing failed logs matching the six exact current ES/EN retired template prefixes are marked OBSOLETE before retry; older unknown historical text is not guessed. No cleaner SMS was sent during verification. Scope savings depend on runtime flags and actual former sends; no production savings figure is claimed.

Validation: 19 focused tests pass (retired-template retries, actual expiry function execution with fake provider boundaries, retained confirmation/reminder wiring, worker syntax transpilation, original reminder timing); scoped backend TypeScript passes. Real phone/provider checks and review of historical retry templates remain pending. No push, merge or deployment.

## Cleaner daily-view continuity — local dashboard correction

Unfinished prior-day tasks now stay in Today rather than being classified as History solely by date. Closed tasks remain in History; today's closed tasks also retain the existing Today visibility. Each property timezone determines day boundaries. This does not extend work/access windows or permit cancellation after window start.

Three view-policy tests and the existing dashboard runtime interaction test passed; dashboard build and focused TypeScript passed. Backend still paginates latest offer IDs before view filtering, so a relevant task can remain beyond the first 25 rows until Load more. Correct server-side view pagination remains pending; this correction alone does not certify complete daily listing. No deployment.

## Per-view server pagination — local correction

Dashboard now requests Today/Upcoming/History explicitly and uses separate query-cache keys/cursors. Backend filters eligible tasks in each property's timezone before the 25-row limit, including unfinished prior-day work in Today and closed work in History. SQL joins are scoped to the authenticated staff and organization and parameters are bound through Prisma. Legacy requests without view retain the old listing contract. No access/work lifecycle mutation or schema migration was introduced.

Isolated SQL verifies today's task behind 30 future offers, prior-day unfinished inclusion, closed History, UTC-midnight Puerto Rico day boundaries, disjoint pagination and foreign staff/organization exclusion. Existing UI runtime test and dashboard build pass; scoped backend/frontend TypeScript pass. Embedded SQL is not production performance certification; native PostgreSQL validation and property-local midnight refresh behavior remain review points. No deployment.

## Weekend availability audit

See `audits/cleaner-confirmation-weekend-hours-20261007.md`: no weekend exclusion exists in inspected source; normal sends are 08:00–18:00 property-local every day. Two current-function tests pass. Real urgent outside-hours dispatch and deadline-aware backup policy remain pending host-configurable design; no hours were changed.

## Cleaner delay/incomplete declarations — local implementation

Authenticated own-task GET/POST issue endpoints now persist append-only CleaningWorkIssueReport declarations. Reservation locking revalidates the sole accepted cleaner and active organization/property/staff scope. DELAY requires unstarted work; MORE_TIME and INCOMPLETE require explicit Start. Closed/cancelled/superseded work rejects reports. Estimates require an explicit timezone, a future instant and a 24-hour input bound; this bound does not authorize any access extension. Request IDs provide payload-checked idempotency. No work, assignment, access, checklist, timing commitment or message mutation occurs.

My Cleanings exposes a bilingual issue form on confirmed/in-progress tasks and the latest recorded report. Arrival/finish estimates use minutes from now converted to an absolute instant and display the property timezone. A lost-response retry retains the request ID and estimate. Success says recorded and does not claim Pin AI evaluated, resolved or extended anything. Cancelled/completed cards have no report form. Recovery policy, host configuration, Pin AI consumption and physical extension remain pending.

Validation: six service tests and four existing route/auth regressions pass with a synthetic JWT secret; scoped backend/frontend TypeScript checks pass; UI runtime test covers the lazy report form, phase options and disappearance after cancellation. Disposable SQL verifies additive migration preserves CleaningWork and enforces report uniqueness/FK/kind/reason constraints. Dashboard build passes. No real provider/SMS/native PostgreSQL concurrency certification. The additive issue-report migration must be applied in the authorized release; no push, merge, migration application to production or deployment.

## Property cleaning recovery limits — local implementation

Added revision-protected CleaningRecoveryPolicy per property and host-only scoped GET/PUT endpoints. Property Edit includes a lazy settings card beside the checklist, with independent save/reload controls and no nested form. Settings are maxDelayMinutes (0–240), maxAccessExtensionMinutes (0–240) and arrivalSafetyMarginMinutes (0–120). Every current/new property can use these settings without an allowlist. Absent policy returns revision 0, delay 30, access extension 0 and safety margin 0; no backfill mutates property timing or cleaner commitments. Zero extension grants no additional access time until a host configures an authorized limit.

This block stores authorization limits only. It does not extend entry, decide arrival readiness, alter reminders or run Pin AI recovery. The UI explicitly says recovery activation is pending. Subsequent evaluation must re-read current property settings, assigned cleaner, work, canonical access period and the next arrival; access extension is allowed only with no next check-in and within the host limit. A reported estimate cannot change the committed duration used for stay-time quotations. Defaults/range validation are not an automatic permission to ignore a booked arrival.

Validation: five service/HTTP tests cover defaults, revision conflict, foreign scope, validation, host roles and rejection of supplied actor/scope. UI runtime verifies save payload/revision, explicit conflict reload and absence of nested forms. Scoped backend/frontend TypeScript and dashboard build pass. Disposable SQL validates additive migration preserves Property rows and enforces FK, uniqueness and bounds. Prisma schema validates. No real provider/native PostgreSQL concurrency certification, production migration, push, merge or deployment. Pin AI decision/command integration remains the next functional block.

## Report assessment connected to cleaner page and Pin AI read status — local implementation

The latest own-work report is now assessed against current property policy, canonical action window, saved access bound and the next arrival. DELAY estimates use the original committed duration to project finish, without altering that commitment. Decisions distinguish following a feasible estimate, required access extension, backup review, host review, cleaner timing-consent action, superseded reports and unverified context. The arrival margin and access end are exclusive finish boundaries. No start window can be reopened; automatic extension proposals require explicit Start and no next check-in, respect the host limit and leave one minute after estimated finish. Access extension 0 disables proposals.

The cleaner issues GET returns this read-only assessment. The page displays estimates and explicitly says an extension has not been applied. Pin AI get_cleaning_status receives the sanitized assessment through its existing read path; no free-text reason, internal work/staff/confirmation ID or token is forwarded to the guest-facing tool. ActionsExecuted/accessChanged/authorizationGranted remain false. This is decision visibility, not execution, host notification, physical verification, readiness certification or automatic reassignment. A prospective command must freshly recheck policy, current assignment, arrival and card authority. Existing reminder schedules and host-attention delivery are unchanged; report-based autonomous follow-through remains pending.

Validation: 53 service/read-tool tests pass, including actual Pin AI adapter assessment and privacy/absence-of-writers, stale/closed phases, delay/arrival/extension boundaries and invalid context. Cleaner UI runtime verifies an extension is not displayed as applied. Scoped cleaner-account and guest-gateway TypeScript, focused frontend TypeScript and dashboard build pass. No migration in this block; preceding issue/policy migrations remain required for release. No push, merge, production command, SMS or deployment.

## Access-extension command preparation — local implementation, not execution

Audited the current physical writers before introducing an extension call. NFC sync and property occupancy reconciliation independently rederive the original cleaner access window; expiry selects the saved ACTIVE end. A provider-only extension would not remain coherent across these writers. They must share the durable approved period/command lifecycle before autonomous extension is activated. This is an integration requirement for this agreed feature, not a separate scale redesign. Current programming and expiry behavior was not changed in this step.

Added internal read-only prepareCleanerAccessExtension. Under the reservation lock it rechecks organization/property/work, the sole current accepted cleaner, latest MORE_TIME report and current assessment. It verifies the cleaner's exact mapped assigned property card, a single stable ACTIVE own grant, and the latest ACKNOWLEDGED programming journal's exact confirmation/org/card/start/end. The journal lock must still belong to this active property; no arbitrary property lock or guest grant is used as a fallback. Conflicting card periods, stale reports, newly present arrivals, reassignment, completion, uncertain/latest programming and missing historical target evidence reject preparation. Its stable report-keyed command snapshot explicitly has authorizationGranted/actionsExecuted/physicalAccessVerified false. It is not exposed as a cleaner or guest action endpoint.

Validation: 11 planning/assessment tests and scoped cleaner-account TypeScript pass. No provider, SMS, access/work mutation, migration or deployment. Next execution prerequisites: durable claimed extension receipt, the host Pin AI activation/terms gate, bounded/recoverable provider command, fresh scope/policy/arrival/target validation and approved-period coordination across sync/reconciliation/expiry. The preparation helper alone does not execute an extension or establish a physical access result. Recovery after already-ended access remains to be defined; this helper only prepares a stable ACTIVE own grant. Native PostgreSQL concurrent sessions and physical provider checks remain pending.

## Automatic issue recovery — local implementation (2026-10-07)

Pin AI recovery now consumes the existing assessment in the reservation worker. A report alone never cancels/completes work or changes its committed duration. Access extension requires an active own grant, exact acknowledged card/lock evidence, explicit Start, no next check-in and the current host cap measured cumulatively from the original access end. A unique durable report-keyed command coordinates reconciliation, sync and expiry. Ambiguous/interrupted hardware attempts require host review and are never blindly retried. Confirmed receipt is visible in the cleaner assessment; physical entry is not certified.

Incomplete-work recovery offers a viable backup without accepting for them. Acceptance rechecks available time, snapshots the actual handoff start, works through portal timing consent/Start, and schedules that backup’s own NFC within the original access window. It does not inherit the previous cleaner’s extension. No viable backup leaves the existing work for host review. Host intervention uses Mission Control and existing durable host attention email.

Urgent offers preserve the existing property-local 08:00 inclusive / 18:00 exclusive SMS hours, including weekends. If waiting until the next permitted hour makes coverage infeasible, the pending offer raises host attention in Mission Control; delivery/explicit acceptance/withdrawal supersedes that delivery alert. No SMS family was added or restored.

Validation: 50 focused assessment/planning/recovery/snapshot/hour tests pass. Two isolated SQL runs pass 9 tests each, including portal snapshot replay, consent/Start, physical-command injection, cap/arrival/uncertainty safeguards, and quiet-hour escalation. Scoped cleaner-account and Pin AI guest-gateway TypeScript, focused frontend TypeScript, Prisma validation, worker bundling, two frontend runtime tests and dashboard build pass. SQL runs use disposable PGlite; native PostgreSQL concurrency and real TTLock/NFC remain unverified. Additional regressions are recorded below.

An unrelated legacy cleaning-end SMS wording assertion fails in its unchanged cost-optimization test; the removed live sending path is independently checked. Browser connection did not complete, so mobile visual review remains pending. Real NFC end-to-end remains pending. Additive 20261007200000_cleaning_access_extension migration must follow issue-report and policy migrations in an authorized release. No production migration, provider command, SMS, push, merge or deployment occurred. Earlier entries describing recovery as pending are historical to their individual blocks.

Final additional regression run: 19 unused-grant/host-notice/routine-SMS-removal tests pass. Action-window/confirmation batch and legacy SMS formatter run passes 22 tests with the one unchanged legacy wording failure noted above.

## Final recovery traversal correction and consolidated review — 2026-10-07

Removed the shared in-memory recovery cursor. Each invocation exhausts locally paginated durable report-backed work; individual failures do not stop later work, and the next invocation starts again from persisted rows. Added failure/interruption/multipage/invalid-size regressions plus an isolated SQL rediscovery test. Physical-command idempotency and UNCERTAIN handling remain unchanged.

Consolidated review: `my-cleanings-review-20261007.md`. The focused closure groups pass 150 tests, backend cleaner-account TypeScript, focused frontend TypeScript and dashboard build. Two stale bilingual SMS formatter expectations now match the unchanged default English formatter. No live message sender was changed. SQL suites run in separate disposable PGlite instances; native PostgreSQL concurrency, mobile browser review and real NFC certification remain pending. No push, merge, production migration or deployment.

## Draft PR publication and continuity — 2026-10-07

Explicitly authorized publication to the two named private repositories. Terminal push lacked credentials; the authorized GitHub connector published consolidated commits with verified exact local tree hashes. Backend Draft PR #376 and Dashboard Draft PR #198 are cross-linked. Original local commit history is documented; new checkouts must use the remote branches. `my-cleanings-continuity.md` records links, source/remote SHA mapping and the closed certification checklist. No merge or production release was authorized or performed. Main compatibility and CI status are not certified by the earlier local tests.

## Main integration and commercial recovery authorization — 2026-10-07

Resolved Prisma/worker/property-editor conflicts while retaining both main commercial Pin AI and cleaner functionality. Automatic staff recovery now uses the canonical commercial activation predicate and verifies current, attributed, non-future terms acceptance; exact-target extension and incomplete handoff revalidate before their command. Fee exemption remains independent of assistance. Normal cleaner cancellation remains independent of Pin AI activation.

Integration groups pass 163 tests; cleaner TypeScript, Prisma generation, worker bundling and Dashboard build pass. SQL uses separate PGlite instances, not native concurrency or physical NFC certification. Integrated main bases and authoritative worktrees are documented in `my-cleanings-continuity.md`. No main merge or production deployment.
