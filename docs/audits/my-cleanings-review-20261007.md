# Mis limpiezas — review against Freddie's decisions

Reviewed 2026-10-07 after reverting the incorrect start-reminder timing change. This is an audit of the local implementation and its connected services, not implementation of new functionality or production certification. The workflow is not ready for deployment.

## Confirmed defects and gaps

| Priority | Finding | Evidence and consequence |
| --- | --- | --- |
| Critical | Replacement NFC ownership is not verified | `cleaner-access-autopilot.service.ts` searches an existing CLEANING NFC assignment by reservation/status and validates its period. It returns success before looking up the accepting cleaner's card. A synthetic call with backup confirmation and primary NFC returned `ok=true`, `alreadyReady=true`, primary assignment ID, and zero backup card reads. A valid backup work assignment is therefore not proof that the backup can physically enter. |
| High | Equal start grace and work duration can omit start reminder | `cleaning-followup.policy.ts` returns START_REMINDER only before committed completion. A 30-minute duration/30-minute grace with missing start returns COMPLETION_REMINDER at minute 30. Staff settings reject this combination, but PropertyStaff defaults and `acceptCleaningOffer` permit it. These paths disagree. The user's rule remains a start reminder at the configured start deadline, not a general deferral to committed end. |
| High | Access remains coupled to availability portal | `/cleaning/confirm/:token/confirm`, and re-entry to an already confirmed portal, call `ensureCleanerNfcAccessForConfirmedCleaning`. Start/completion/cancellation work services do not mutate access, but the broader requirement that access is independent of portal actions is not fully implemented. The access owner needs separate scheduling/recovery authority. |
| Medium | Daily view does not retrieve a complete daily set | `/api/cleaner/cleanings` pages 25 offers by descending ID. `MyCleaningsPage.tsx` then filters only loaded pages into Today/Upcoming/History. Today's older task can be behind 25 newer offers and absent until Load more. Unfinished work from a prior date is placed in History, even when completion is still permitted without a next arrival. |
| Medium | Generic SMS retry has no cleaning-work revalidation | `message.retry.worker.ts` retries failed SMS through its generic send path. It has special guest rules but no current cleaner work/offer/phase check. A failed reminder is not retired by cleaner completion (the completion route retires host notices). Stale cleaner SMS can therefore remain eligible for retry. This finding is source-traced; no provider message was sent. |
| Pending functionality | Routine recovery still escalates directly to host | `reservation.worker.ts` persists missing-completion host attention and queues/delivers the host notice at the existing grace deadline. Pin AI recovery, delay/incomplete declarations, authorized access extension and host-configured recovery limits are not implemented. Backup exhaustion tracking is durable, but is not an autonomous recovery executor. |

The NFC ownership defect is in the connected access service; implementing replacement without testing that integration was an incomplete prior validation. Passing work-state SQL tests never certified substitute physical entry.

### Local ownership guard correction

The existing-grant shortcut now resolves the accepting Staff member's property card mapping and requires its ID to match the grant before returning readiness. Missing or different mappings return `CLEANER_ACCESS_CARD_MISMATCH`, with failed access evidence rather than a successful readiness claim. Existing same-card access still requires the canonical window.

Nine new regression cases and nine existing provisioning/property reconciliation cases passed with injected storage/provider dependencies. The cleaner-account TypeScript check includes the new test. This correction does not transfer access: it neither revokes the former card nor provisions the backup in the mismatch branch. Independent reassignment reconciliation, physical provider validation and autonomous recovery remain release blockers. A returned `escalated` flag denotes the existing failure result/audit path; this change adds no cleaner SMS or host notification.

Further source review found that `reservation-complete-flow-audit.service.ts` can bypass this guard: any latest cleaning NFC SCHEDULED/PROVISIONING/ACTIVE row is treated as lifecycle-valid before checking the current cleaner's card. Autopilot runs only for an invalid lifecycle, and the later window check does not verify ownership. The sync worker also lacks current cleaner/card authority checks before executing obsolete scheduled/retry grants. Neither path was changed in the ownership guard commit. See `../cleaning-access-reassignment-design.md` for the proposed independent transfer and race/recovery requirements; this remains a release blocker.

The subsequent local audit correction now requires the confirmed cleaner's mapped property card to match before recognizing SCHEDULED/PROVISIONING/ACTIVE lifecycle evidence. An old generic Staff access grant cannot bypass NFC ownership verification when cleaning NFC is enabled. Mismatched live card evidence and escalated repair failures are FAIL, and skipped repair is not readiness. Ten runtime regressions execute the full audit with storage/repair boundaries injected; they passed, along with the cleaner-account TypeScript check. The prior eighteen focused access regressions passed during this block as well. This changes audit evidence, not the two-hour programming horizon or physical periods. Independent transfer and stale worker/retry authority remain unimplemented.

The next local worker correction checks current confirmed assignment and mapped card after claim, before programming and after acknowledgement. Failed ownership/authority is not a generic retryable NFC error. Twenty-seven cleaner/guest worker regressions passed, including primary SCHEDULED before two hours, backup programming at two hours with future entry, stale primary SCHEDULED/FAILED/PROVISIONING rejection and assignment changes around provider calls. The cleaner-account TypeScript check now includes the provisioning test. This does not revoke prior physical permissions or implement atomic card/lock command ownership; unresolved physical state and native concurrency remain release blockers. No provider, phone or production test was run.

Unused-grant reassignment now retires only a prior cleaner's never-attempted SCHEDULED intent, with terminal-offer/card provenance, a reservation lock and conditional update competing with worker claims. The access service then schedules the confirmed replacement's own card and canonical window. Full-flow audit reads successful repair evidence rather than certifying the retired snapshot. Forty-eight focused helper/service/audit/provisioning regressions passed. Previously programmed or uncertain grants and an independent cancellation recovery scanner remain unimplemented; no physical provider was called.

Programmed-permission target review: sync persists no TTLock lock target on NfcAssignment. Natural expiry derives a lock from the first reservation access grant and can close an expired database record without a hardware call when a target is absent. That existing expiry behavior must not be treated as proof of early withdrawal. Reassignment requires original organization/lock/card command provenance and serialized recovery, including historical-target evidence and delayed provider outcomes; see the design's programmed-permission withdrawal section. This is source review, not a newly reproduced physical expiry failure. No lifecycle/schema/provider change was made in this review block.

The subsequent local provenance implementation adds `CleanerNfcProgrammingAttempt` via migration `20261007090000_cleaner_nfc_programming_attempts`. Cleaner programming records the exact command target and period before sending, then distinguishes acknowledgement, aborted and uncertain outcomes. Failed preparation prevents the provider command. Unused-grant retirement also requires no programming records. Fifty-seven focused regressions and disposable embedded-SQL migration preservation/constraint checks passed. Historical grants remain unbackfilled; physical withdrawal, command serialization, provider read-back and independent recovery remain pending. No production migration or provider call was performed.

## Rules supported by the reviewed local code and tests

| Rule | Review result |
| --- | --- |
| Cleaner account sees only its own tasks and cannot use host routes | Own Staff/org binding and role checks; account/HTTP/MFA regressions pass. Public token links retain their bearer-link model. |
| Preferred language | Cleaner profile, dashboard, portal and existing message builders use Staff preferred language. |
| Start only in the correct window | Authoritative POST checks scheduled start and exclusive upper bound; open-page button timer also checks at submit. |
| Complete only after explicit start | Start is required; no minimum work-duration wait. Required checklist items must also be checked. |
| Completion upper bound | With a next arrival: minimum of planned access end, recorded assignment end and next arrival, exclusive. Without a next arrival: completion remains possible after access expiry; a new start does not. |
| Completion and access independence | Start/completion write work declarations, not NFC/grants. Access expiry is not work completion evidence. Broader availability/access coupling remains a finding above. |
| Duration vs access allowance | Work commitment is snapshotted per accepting cleaner; shared access-window policy derives a separate allowance. Stay-time departure reader binds the current accepted/consented work and rejects cancellation, ambiguity and changed duration. |
| Confirmed cancellation | Allowed before start, serialized with work transitions. It preserves task checklist and selects the next viable configured candidate with explicit acceptance required. Missing start alone does not call withdrawal. |
| Checklist lives per property | Host template plus fixed per-reservation task snapshot. Replacement retains snapshot/progress; prior work does not acquire retroactive required items. |
| All current/new properties | No new cleaner property allowlist found. The current flow still requires existing Staff/property configuration and cleaning NFC enablement; no automatic activation of Staff Manager was performed. |
| No new cleaner SMS family | The reviewed account/reassignment/checklist/status/exhaustion blocks add no SMS family. Reminder cost consolidation and delivery certification are unfinished. |

## Pending validation and scope decisions

- Availability offers currently appear in the dashboard while PENDING. Freddie asked about retaining text acceptance before dashboard visibility. The present code exposes pending offers as well as accepted tasks; this needs a clear reviewed visibility rule.
- Availability hours are 08:00–18:00 in the property's timezone. No weekday exclusion was found in the dispatcher examined. Short-notice/weekend behavior and urgent outside-hours policy have not been certified; this does not establish that production weekend bookings are covered.
- Native PostgreSQL concurrent-session behavior and real phone/SMS/NFC tests remain pending. No production writes, messages, merge, migrations or deployment occurred during this review.
- Existing/new-property release verification remains mandatory; passing synthetic tests does not complete the project.

## Verification performed

130 backend regressions and two React runtime tests passed. Two additional synthetic executions reproduced the NFC ownership and 30/30 reminder defects above against actual service/policy functions, with injected storage and no provider calls.

The first combined embedded-SQL run passed MFA cases but hit PGlite socket prepared-statement collisions between separate test processes (`42P05`, prepared statement `s0` already exists). That is a harness limitation, not evidence of an application transition failure. Rerunning account lifecycle, work windows, checklist and reassignment with a fresh disposable database per file passed all 26 test entries (including checklist parsing/render checks). Native multi-session PostgreSQL remains uncertified.

## Recommended correction order

1. Verify replacement card ownership and independent access scheduling; add a regression that previously returned primary NFC as ready for a backup.
2. Resolve the start-reminder/settings/acceptance discrepancy while retaining the user's original start deadline, then guard stale retries.
3. Retrieve complete daily/upcoming task sets and surface actionable overdue work.
4. Complete reviewed Pin AI recovery/host configuration, message consolidation and urgent-booking behavior.
5. Compile, run focused regressions and perform the authorized real phone/access release test before claiming completion.
