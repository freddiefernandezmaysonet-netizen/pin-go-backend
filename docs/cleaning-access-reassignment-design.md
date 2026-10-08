# Cleaner access reassignment — review design

Status: design for review, not implemented or deployed. Applies to all configured properties. Preserve the existing normal cleaner/card provisioning behavior. Work declarations and access grants remain separate.

## Desired behavior

Freddie confirmed the existing scheduling contract: primary and backup follow the same rules. Acceptance creates a SCHEDULED NFC assignment with the canonical access window. It remains SCHEDULED until two hours before window start; at that threshold the worker may program the card with the future startsAt/endsAt. ACTIVE after provider acknowledgement denotes a programmed permission, not permission to enter before startsAt. Physical entry remains limited to the programmed window. Acceptance within the two-hour horizon makes scheduling immediately eligible, without backdating or extending entry. Preserve this existing two-hour provisioning behavior.

When an accepted cleaner withdraws before starting, the work service commits the cancellation and the next viable offer. It does not call TTLock. An independent access reconciler reads current assignment authority and reconciles obsolete access even if no replacement has accepted yet. Start and completion are never triggers to grant/revoke access. Explicit work completion leaves the current valid grant available until its access end; access expiry never records work completion.

The proposed cancellation access rule is to withdraw the cancelled cleaner's reservation-specific permission. This is an assignment change handled by the access system, not a start/completion dependency. It must not remove that cleaner's card registration, property staff membership or valid permissions for other work.

| Situation | Access reconciliation |
| --- | --- |
| Former grant is SCHEDULED and has never been sent to TTLock | Retire the obsolete scheduling intent so workers cannot provision it. |
| Former grant is ACTIVE | Request closure of its physical period; record closure only after provider acknowledgement. |
| Former grant is PROVISIONING or a prior request timed out | Treat physical state as uncertain; coordinate with the in-flight command and reconcile it. A database-only cancellation is insufficient. |
| Backup offer is pending | Do not provision backup access before explicit acceptance. Continue reconciliation of obsolete access. |
| Backup accepts with a distinct valid card | Create its SCHEDULED assignment with the canonical access window. Program it only when within the existing two-hour horizon, with entry restricted to startsAt/endsAt. Declare scheduling and provider acknowledgement separately; obsolete permission reconciliation must be complete before reporting transfer complete. |
| Card mapping is missing, ambiguous or shared with the previous cleaner | Do not claim personal access or guess the owner. Resolve mapping before transfer. A shared physical card cannot establish independent cleaner ownership. |
| Provider fails or times out | Keep acceptance intact and access recovery pending. Retry through the access owner; never falsely record closure or activation. |
| Window expires or a nearer check-in removes available time | Stop obsolete grant/retry attempts and surface the remaining operational exception. Do not silently complete the task or extend into occupancy. |

Pin AI should manage routine retries and recovery under the host's configured limits. Host attention is reserved for unresolved critical cases: invalid card mapping, exhausted recovery or an approaching deadline that threatens entry/turnover. This is proposed recovery behavior, not a currently implemented executor, and adds no cleaner SMS family.

## Authority and race requirements

- Each access intent needs durable provenance tying the reservation, accepted assignment and mapped physical card together. Card label alone is the current mapping mechanism, not a durable identity guarantee.
- The access reconciler must discover work assignment changes without relying on the cleaner revisiting the confirmation portal. Use the existing worker infrastructure; portal entry is not the recovery owner.
- Recheck current authority and current occupancy before executing a physical command. Serialize commands affecting the same card/lock and reject stale assignment generations. Recheck after acknowledgement; if authority changed during the request, reconcile the physical outcome rather than declaring stale access ready.
- Workers must not provision or retry obsolete cleaner grants. Claiming a grant row alone does not protect against cancellation/reassignment while a provider request is in flight.
- TTLock and the database cannot share an atomic transaction. Persist intent and retry/reconciliation evidence; handle successful physical writes followed by failed database persistence without granting duplicate permissions.
- Keep current occupancy and early check-in limits authoritative. Work commitment duration does not replace the access window.
- Repeated scans, acceptances and cancellation replays must produce one effective intent and no duplicate physical transfer. No clean-up may change guest access or unrelated cleaner grants.

## Current evidence and remaining integration gaps

### Unused scheduled grant transfer implemented locally

When the access service encounters a different-card SCHEDULED grant with zero attempts and no provisioning timestamps, it can retire that unused intent after verifying a terminal prior offer, its former Staff card mapping and exactly one current confirmed replacement. The helper locks the reservation (shared with work reassignment transactions), then uses a conditional update requiring CLEANING/SCHEDULED, retryCount zero and both provisioning timestamps null. A competing worker claim prevents retirement. The service then re-reads the confirmed assignment and schedules the replacement's own mapped card through the existing path, without a provider call or changes to the two-hour horizon.

The full-flow audit now accepts successful replacement intent evidence rather than checking the retired pre-repair snapshot's ownership/window. Forty-eight focused helper/access/audit/provisioning tests passed. This covers unused programming transfer; it does not close ACTIVE, PROVISIONING or previously attempted/uncertain permissions, change staff membership, or add an independent cancellation scanner. Native concurrent database/provider transfer is still uncertified.

The initial ownership guard in `cleaner-access-autopilot.service.ts` rejected an existing different card instead of claiming it ready. Its initial eighteen focused tests and cleaner-account TypeScript check passed. The later unused-transfer helper above extends only the provably unprogrammed case; all other mismatched live permissions still require reconciliation.

Source inspection found a second readiness path in `reservation-complete-flow-audit.service.ts`: it considered the latest cleaning NFC SCHEDULED/PROVISIONING/ACTIVE state lifecycle-valid without accepting-cleaner ownership verification. The subsequent local correction now checks the confirmed cleaner's property card, gates lifecycle evidence on ownership, rejects live mismatched-card evidence and prevents legacy Staff access from bypassing NFC validation. Ten full-audit runtime regressions and the cleaner-account TypeScript check passed. No production or provider execution was performed. This correction does not implement physical transfer.

The initial inspection found that the NFC sync worker recalculated windows without checking current accepted cleaner/card authority. The local worker correction now requires exactly one current offer, CONFIRMED status, an active same-organization Staff and its mapped property card. It checks after claiming, immediately before the provider write and after acknowledgement, preserving the same confirmation ID within the attempt. Obsolete/ambiguous authority and card mismatch fail without the generic retry prefix. A changed or unverifiable authority after physical programming leaves FAILED evidence with `CLEANER_ACCESS_AUTHORITY_UNVERIFIED_AFTER_PROGRAMMING`; it does not falsely record ACTIVE.

Twenty-seven focused cleaner/guest worker tests passed, including the unchanged two-hour horizon and future physical window. This is a validation guard, not a physical revocation executor. A provider write can succeed during a concurrent reassignment, and a reassignment can still occur after the final authority read before persistence. Card/lock command serialization, durable ownership generations, cleanup of already-programmed/uncertain permissions and complete independent transfer remain required. The property reconciler adjusts occupancy windows, not assignment ownership. Native concurrent/provider transfer is not certified.

## Required verification before release

1. Existing primary acceptance and its own card still program normally; provider success and failure remain distinguishable.
2. Primary cancellation before start retires future scheduling and reconciles active/uncertain permissions without altering other work.
3. Backup acceptance retains checklist and uses the backup's own card; both readiness service and complete-flow audit reject primary-card evidence.
4. Cancellation during provisioning, delayed provider response, stale retry and database failure after physical acknowledgement cannot reactivate an obsolete permission or report false readiness.
5. Same-card/ambiguous mapping is surfaced explicitly; no collateral card revocation is performed.
6. Completion keeps access through the approved end; expiry does not complete work. Next check-in caps all writes and recovery.
7. Real provider/phone evidence and native concurrent PostgreSQL validation follow the separately authorized release. Local tests alone do not certify physical transfer.

## Programmed permission withdrawal — target audit

Source review of `nfc-sync.service.ts`, `nfc-expire.service.ts`, `ttlock.card.ts` and the Prisma NFC schema establishes these implementation constraints:

- Programming selects an active property lock, resolves organization auth and calls changePeriod for that lock/card with the cleaner's time window. The assignment records the card, dates and provider acknowledgement timestamp, but not the actual TTLock lock ID used for the command.
- Natural cleaning expiry chooses a lock from the reservation's first access grant, and moves the card period into the past when a target is present. It closes expired assignment records even without that target. This is existing expiry behavior; it is not evidence that anticipatory cancellation physically withdrew permission.
- A cancellation operation before endsAt must have the original programming target and provider acknowledgement. Current active property lock or the first guest grant cannot substitute for proven programming provenance.
- A timeout creates an uncertain physical outcome, including a late provider completion. A database FAILED/ENDED state is insufficient to prove physical closure. The operation must retain its target and recovery phase rather than lose that evidence.
- Card registration and valid permissions for other reservations must remain intact. Inspect other grants for the same physical target before changing a period; shared/conflicting authority needs reconciliation, not unconditional removal.

### Concrete next implementation boundary

Persist the exact organization/lock/card target and command identity for each cleaner programming attempt before sending it. Use the same serialized command authority for programming and withdrawal, with durable recovery phases for queued/attempted/acknowledged/uncertain operations. Recheck current assignment and occupancy under that authority. The two-hour programming eligibility and future physical period remain unchanged.

For historical permissions without target evidence, recovery must establish the target from reliable provider evidence before early withdrawal; it must not silently guess a property lock. Neither backfill nor provider verification has been executed. The additive storage and command serialization design must cover delayed responses and database failure after provider acknowledgement before physical withdrawal is implemented.

Once withdrawal is acknowledged for the former permission, the backup's own SCHEDULED intent proceeds through the existing two-hour horizon. Accepted work stays accepted while access recovery is pending. Pin AI handles routine recovery within host-configured limits; only unresolved deadline-threatening or ambiguous cases require host attention. No new cleaner message family is proposed.

This block is an audit/design clarification only. No expiry behavior, schema, provider calls or production configuration were changed.

### Subsequent local programming provenance implementation

Additive migration `20261007090000_cleaner_nfc_programming_attempts` introduces `CleanerNfcProgrammingAttempt`. Each cleaner attempt records assignment/confirmation identity, attempt number, organization, exact TTLock lock/card and future period before the provider command. If preparation cannot persist, no physical command is sent. State distinguishes PREPARED, ABORTED before sending, ACKNOWLEDGED provider response and UNCERTAIN attempted outcomes. Provider acknowledgement remains evidence even when assignment validation or later persistence fails. No tokens or provider credentials are stored.

The unused-grant retirement condition now also requires no programming attempt records, so zero counters cannot override durable programming evidence. Guest programming is unchanged. Fifty-seven focused cleaner/guest/provenance/unused-transfer regressions passed, and disposable embedded SQL verified additive preservation of existing NFC rows, unique attempt identity, foreign key and state/window/attempt constraints. The cleaner-account TypeScript check includes the changed paths.

This table is new local code, not an applied production migration. Deploying this code requires applying the additive migration and regenerating Prisma first. Historical grants are not backfilled with guessed targets. This step records programming provenance; it does not execute withdrawal, serialize card/lock commands, read back physical TTLock state or implement the independent recovery scanner. Those remain release blockers.

### Provider period evidence reader prepared locally

Official contract review on 2026-10-07: [changePeriod](https://euopen.ttlock.com/doc/api/v3/identityCard/changePeriod) accepts lock/card IDs and millisecond start/end dates, with gateway changeType 2 and errcode/errmsg response. [identityCard/list](https://euopen.ttlock.com/doc/api/v3/identityCard/list) reports card/lock IDs and start/end dates, with paginated pages up to 100 rows. Its status field describes NB-IoT operation states; it must not be treated as gateway physical acknowledgement.

`readCleanerCardPeriodEvidence` reads the exact recorded lock/card target with explicit auth and bounded pagination. It distinguishes reported FUTURE/IN_WINDOW/EXPIRED periods, not listed, ambiguous and unverified responses. Malformed dates/targets, incomplete scans and pending/error states do not become withdrawal evidence. Provider exceptions propagate to the eventual recovery caller. Every result declares physicalAccessVerified false: the documented inventory contract does not promise a live physical lock read. That boundary is an implementation inference from the contract, not an assertion that gateway changePeriod cannot apply a period.

Eleven injected-provider regressions and the cleaner-account TypeScript check passed. This reader is not wired into a withdrawal worker yet, performs no operation on work or grants, and adds no messages. No account/provider inventory was queried during verification. Physical withdrawal execution, shared command serialization, recovery integration and real hardware certification remain pending.

## Integrated recovery flow for review

The existing `access-recovery.service.ts` supplies a compare-and-set attempt ownership pattern, bounded retries and recovery after worker interruption. It is tied to AccessGrant ACTIVE records and has fixed waits ranging from one minute to six hours. It cannot directly own cleaner NFC withdrawal or use those delays unchanged for an approaching turnover. Adapt the ownership pattern to cleaner command intents and their remaining deadline, without altering guest recovery behavior.

| Event | Required result |
| --- | --- |
| Cleaner withdraws before recorded start | Commit work cancellation and next viable offer; the access owner discovers the obsolete permission independently. No work button calls TTLock. |
| Backup accepts | Preserve explicit acceptance and checklist; immediately create its own SCHEDULED intent with the canonical access window. Prior physical withdrawal may still be pending. Scheduling an intent does not declare provider programming or early entry. |
| Prior intent is provably unused | Retire through the implemented conditional update and continue normal scheduling. |
| Prior permission was programmed | Queue withdrawal on its recorded organization/lock/card target; preserve command identity and attempt ownership. Protect other valid permissions on that same target. |
| Within two hours of backup access start | Program the backup only once prior permission reconciliation and command ownership allow it. Use future startsAt/endsAt unchanged. If accepted inside the horizon, it is eligible on the next worker cycle. |
| Provider acknowledges withdrawal | Persist acknowledgement durably. Inventory read-back can provide period evidence, with physical verification remaining distinct. Clear the appropriate reconciliation gate; do not close unrelated grants. |
| Timeout or worker interruption | Preserve uncertain outcome, target and intent. Reconcile before competing/replacement writes to the same target; elapsed lease time alone is not proof of physical withdrawal or completion of the old command. |
| Routine recoverable failure | Access owner retries within the configured budget and remaining turnover deadline. Pin AI coordinates routine follow-up. Acceptance stays valid; no new cleaner SMS family is introduced. |
| Exhaustion, ambiguous target or endangered deadline | Persist one operational exception using existing host attention infrastructure. Escalate the unresolved critical case, not every failed attempt. |
| Cleaner completes work | Keep access until its valid end. Neither completion nor access expiry changes the other lifecycle. |

### Host policy boundary

Host configuration controls recovery attempt budget, retry interval, escalation lead time and the maximum additional access Pin AI may authorize when no next check-in exists. Existing confirmed arrival commitments and exclusive access end remain hard limits; a configuration value cannot extend into a next check-in. The precise settings/defaults and Pin AI executor are still pending implementation; no new host setup requirement was activated in this block.

### Execution coverage needed before connecting withdrawal

Programming and withdrawal must share durable ownership by organization/lock/card, not only by reservation. All cleaner period writers need coverage: sync programming, occupancy-window reconciliation, natural expiry and manual unassignment. Every queued command rechecks current authority and target; uncertain previous commands prevent claiming a successful transfer. Existing guest operations and ordinary principal-card provisioning must retain their behavior.

The current access service handles immediate replacement scheduling only for the provably unused prior grant. When a prior live physical permission is mismatched, it returns a reconciliation failure and does not yet create the backup's intent. Therefore immediate SCHEDULED creation while physical recovery is pending is an explicit remaining implementation gap. The programming journal and period reader are prerequisites, not the integrated executor.

This review completed source inspection and defined the integrated contract. It added no executable recovery logic, provider calls, schema changes or messages. Release remains blocked until this orchestration, command coverage, timing/message/UI gaps and authorized end-to-end verification are complete.

## Authoritative policy correction — 2026-10-07

The user permits an already-programmed former cleaner permission to expire naturally when that cleaner cancels before window start. Physical withdrawal is therefore no longer a prerequisite for offering or programming the accepted backup. Earlier withdrawal-first recovery requirements in this design are superseded by this decision. An unused scheduled permission must be cancelled and never programmed. The two-hour programming horizon and future physical start remain unchanged for both primary and backup.

Cleaner cancellation is allowed after acceptance only before the current canonical window starts; once the window starts it is forbidden even without explicit Start. The local backend and UI boundary correction is implemented; cancellation-to-access lifecycle integration and replacement scheduling alongside retained programmed permission remain pending.

The accepted-backup SCHEDULED creation alongside an explicitly cancelled former ACTIVE grant is now implemented locally. It preserves the former grant and uses current-offer/card/overlap checks under the reservation lock. Uncertain/inflight prior programming remains a separate pending recovery case; no physical withdrawal executor was introduced.
