# Pin AI cleaning status — read prerequisite

## Audit finding

`get_cleaning_status` previously returned only `CleaningConfirmation.status`. `CONFIRMED` means the cleaner accepted the offer, not that work started or finished. The existing missing-completion follow-up opens host attention; the host incident policy has no cleaning recovery/extension action. Exhausting viable backups therefore still needs a durable operational recovery workflow.

## Implemented locally

The read adapter verifies reservation/property/organization scope, selects the current pending or confirmed offer, and reads only its cleaner's uncancelled, unsuperseded `CleaningWork`. Internal offer/staff IDs and tokens are excluded from the result.

| Work status | Meaning |
| --- | --- |
| NOT_REQUESTED | No offer history |
| NO_CURRENT_ASSIGNMENT | Only terminal offers remain |
| AWAITING_ACCEPTANCE | Current offer is pending |
| AWAITING_TIMING_CONSENT | Accepted work has no timing consent or start |
| AWAITING_START_CONFIRMATION | Timing consent exists; start is missing |
| IN_PROGRESS | Explicit valid start exists; completion is missing |
| COMPLETED | Explicit start and completion exist, in chronological order |
| WORK_CONFIRMATION_UNAVAILABLE | Work or required timestamp evidence is missing/invalid |
| AMBIGUOUS_ASSIGNMENT | Multiple current offers or work records |

`completionDeclared` identifies the cleaner's recorded completion. Physical verification remains false. Access expiry is never completion evidence; duration commitment is reported independently of access. `latestStatus` and sanitized offer history remain for compatibility, alongside the explicit work status.

This tool describes the departure cleaning associated with the request's reservation. It does not determine readiness for an arriving reservation, authorize early check-in, extend access, reassign staff, send messages, or write operational state. Arrival readiness requires the correct preceding cleaning and current occupancy constraints.

## Remaining work

Backup exhaustion now has durable operational attention and superseded-offer deduplication; see `cleaning-backup-exhaustion-v1.md`. Connect delay/incomplete declarations and host-configured recovery limits next. Pin AI should handle authorized routine steps before escalating critical or exhausted cases. No automatic access extension is included in the status read change.

## Validation

Read-adapter regressions cover acceptance without work, pending replacement, cancellation, missing timing/start evidence, explicit start/completion, invalid chronology and ambiguous assignments. They also assert scope, sanitized output and absence of operational authority. All validation is synthetic; no provider messages or production changes are made.

Validated on 2026-10-07: 226 runtime tests passed; guest gateway typecheck and strict source/test typecheck passed; backend bundle and whitespace checks passed. Provider and live phone certification remain pending the authorized release.
