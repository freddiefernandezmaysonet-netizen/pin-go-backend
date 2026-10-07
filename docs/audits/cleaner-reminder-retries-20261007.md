# Cleaner reminder retry audit — 2026-10-07

Scope: source audit only, no SMS sent and no runtime behavior changed.

## Findings

- `cleaning-followup.policy.ts`: start reminder uses scheduled start plus configured start-confirmation grace while start is missing; completion reminder uses scheduled start plus committed duration. Late explicit start does not shift committed completion. No access-window expiry completes work.
- `cleaning-followup-delivery.service.ts`: initial delivery reads work and suppresses cancelled, superseded or completed work; start reminder also suppresses recorded start. However later context reads do not revalidate cancellation at the last delivery boundary. Reservation select omits status and confirmation select omits status, so independently cancelled reservation/offer context is not checked there.
- `message.retry.worker.ts::processRetries`: FAILED SMS rows are retried generically; guest-specific exemptions/consent checks exist, but no cleaner work/offer/phase validation precedes `sendSms`. A reminder failed before cancellation can therefore still retry afterward. This is a source-supported path, not evidence of an actual delivered obsolete production SMS.
- `cleaning-followup-delivery-reconciliation.service.ts` associates legacy delivery evidence by reservation, recipient and communication type/time. Exact work/offer correlation must be reviewed before claiming reassignment-safe delivery evidence.

## Correction contract

Before retrying an existing cleaner reminder, resolve its exact confirmation/work from durable context (existing action URL where validated, or an explicit persisted identifier), verify reservation/property/recipient ownership and current accepted offer, reject closed work, and re-evaluate whether that reminder phase is still useful. Do not substitute the backup's token or silently repurpose the previous message. Retire obsolete messages using existing message-log terminal status with a reason, preserving history. Ambiguous identity must not cause a guessed delivery. Apply equivalent scope/status checks to initial delivery.

Preserve current timing: start reminder at scheduled start plus configured grace; completion reminder after committed duration. Do not delay start reminder to completion. No new cleaner SMS families or extra messages are proposed.

The grace-equals-duration configuration inconsistency remains a separate known issue: policy has no interval for START_REMINDER when both equal, while acceptance and host settings enforce different invariants. This audit does not change defaults or cadence.

## Validation

18 current policy/cadence/cycle/receipt/reconciliation tests passed. They verify existing scheduling and receipt behavior; they do not prove stale retry suppression, which is currently absent. No code change, deployment or provider test in this audit.
