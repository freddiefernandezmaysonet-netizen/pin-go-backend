# Twilio SMS failure V1 — bounded retry policy foundation

## Status and scope

Draft implementation based on main `e9df89176a564a7f68e23c8cd02a539fcde065ee`.
The policy is **not mounted** in the webhook, retry worker, provider adapter or
Mission Control persistence. No deployed behavior changes. Returned hostAction,
retryPlan and replay decisions are plans, not provider calls, incidents or
runtime fences already executed.

## User clarification — October 2, 2026

Freddie correctly noted that 30005 may be temporary: a guest may have a powered-off
phone or no signal, including while travelling. He requested at least one retry
or letting the flow continue to the next scheduled message, citing 2 pm in this
reservation. This supersedes the first slice's unconditional no-replay decision.
The screenshot does not prove the actual guest was travelling or offline.

The revised policy permits **one delayed retry per logical message** when current
evidence supports it. A failure of one message never independently suppresses
later scheduled communications. Their own consent, recipient, reservation,
access-release and expiration requirements still apply; this is not an opt-out
bypass or permission to send arbitrary follow-ups.

Retry time and spacing are explicit server-policy inputs, not a global 2 pm
schedule or a configured production default. Tests use a 30-minute delay and
15-minute separation as examples. Those intervals have not been activated.

## Observed production incident and limitations

The user supplied a Twilio screenshot showing an outbound PRECHECKIN SMS for
Serena Studio on October 2, 2026: created about 12:00:01 GMT-4, sent about
12:00:02, then undelivered about 12:00:04 with carrier code 30005. The worker
logs in the corresponding window showed one pre-checkin candidate and a Twilio
initialization. This correlates content/time; it is not a database join proving
the original Channex phone, Reservation row and exact provider Message SID.
Do not put the guest phone, SMS body, property coordinates, access code or
original live Message SID into tests or this document.

The prior source audit found that the relevant Channex/ingest/sendSms path
passes the selected phone through, rather than guaranteeing E.164 conversion.
The live raw phone chain still requires exact evidence; source inspection alone
must not be described as certification of a specific guest's input.

The existing application records local send-attempt SENT separately from
providerDeliveryStatus. The existing callback code can already record 30005.
The inspected production variable names lacked TWILIO_AUTH_TOKEN on the API,
reservation worker and message retry worker; the workers also lacked the
delivery-webhook flag. Values were redacted. This candidate changes none of them.

## Implemented pure contract

- Only exact provider twilio + channel sms enter this policy.
- ACCEPTED/QUEUED/SENDING/SENT without a delivery receipt never mean delivered.
- UNDELIVERED or FAILED with exact 30005 is evidence about a failed attempt,
  not proof that a phone is permanently invalid.
- Current correlated retry evidence is required. Missing evidence is not assumed
  to mean zero retries. The same logical message's durable retriesUsed count must
  survive a new provider SID; repeated callbacks cannot reset the anchored delay.
- With zero retries used, a future retryNotBefore produces WAIT_FOR_RETRY. At the
  due time the decision can be RETRY_ELIGIBLE, with ordinal 1 and a stable key.
  It is not an instruction to send directly in callback handling.
- A next independently eligible message that is due sooner or too close takes
  priority: WAIT_FOR_NEXT_MESSAGE omits the old retry plan and creates no new
  host demand. The retry plan's expiration is also capped by that spacing boundary.
- A scheduled time does not prove delivery. Different content does not silently
  replace missing arrival or access instructions or mark the old SMS delivered.
- After one retry is used, another 30005 produces a host-action plan while later
  scheduled messages remain independent. Access-message failure is critical;
  arrival-message failure is a warning. No lock failure is inferred.
- Claimed/uncertain retry outcomes cannot trigger blind replay. Internal review
  is required; future persistence/reconciliation must make this bounded and durable.
- Invalid scope, dates, attempt correlation, changed recipient/content or
  contradictory provider evidence fail closed for this retry.
- PRECHECKIN replay expires no later than check-in. Access replay expires no later
  than checkout or its earlier current content/access deadline. No expired content
  is replayed, and unavailable safe retry windows can require host action.
- Host incident identity includes messageLogId and the exact provider SID. A scoped
  existing workflow owns recovery; duplicates do not reopen resolved actions.
- Every decision explicitly states blockOtherScheduledMessages=false. This only
  describes this failure policy; independent blocking policies retain authority.
- Metadata excludes destination numbers, message bodies, guest tokens, access
  codes, provider error free text and credentials.
- No database writes, provider calls, reservation/access edits, destination
  blacklist or automatic email/Airbnb fallback are implemented in this module.

## Validation

First slice `b02ca711` passed 61 tests locally and in workflow 37041779778.
The revised policy passes 100 emitted JavaScript tests locally with strict
TypeScript, exactOptionalPropertyTypes and noUncheckedIndexedAccess on Node
22.16.0 / TypeScript 5.8.3. Retained host-action cases now explicitly model an
exhausted retry; 39 additional cases exercise the new bounded recovery contract.
The existing isolated workflow and compiler configuration are unchanged.
Remote CI must be reported against the newly published head, not the first slice.
This is not PostgreSQL, signed HTTP, provider or full-backend certification.

## Remaining integration gates — not implemented here

1. Authenticate callbacks and correlate them to exactly one persisted provider
   attempt. Retain early/unmatched/out-of-order receipts without losing evidence.
2. Persist the original failure time, delay, one-retry budget and claim before I/O.
   Test concurrent callbacks/workers, rollback and crash recovery in PostgreSQL.
   A new SID must not reset the logical-message count. Unknown send outcomes must
   be reconciled, not retried blindly. No resend may use a masked log body.
3. Enforce the decision in active retry/manual/APMS paths. Revalidate current
   recipient, content, consent, reservation and access state before provider I/O.
   Coordinate the retry with the separate schedule so concurrent workers cannot
   send both at once. When yielding, persist that the old retry was skipped, then
   follow the scheduled message's real outcome; do not wait indefinitely on a time.
4. Wire host visibility and resolution/recovery after repeated failure, missing
   next-message outcome or urgent access problems. Do not claim email/OTA fallback
   or resolution of one missing instruction from unrelated delivered content.
5. Configure secure callbacks separately in the API and all sending workers.
   Never put Auth Tokens into chat, source, CI or logs. Choose the production
   delay/separation policy explicitly before activation; no interval was deployed.
6. Run an authorized live canary and prove one retry, independent subsequent
   messaging, correct delivery evidence and no duplicates. Historical receipts
   require explicit reconciliation; future callbacks do not backfill them.

No merge, deployment, persistent database change, Railway configuration change,
real SMS/email/provider call or production activation was performed. Other PRs
and existing certification allowlists remain untouched.

## Primary provider documentation reviewed

- https://www.twilio.com/docs/api/errors/30005
- https://www.twilio.com/docs/messaging/guides/track-outbound-message-status

Twilio lists powered-off devices, insufficient signal, unknown numbers, inability
to receive SMS and carrier issues as possible causes, and suggests another test
message. One delayed retry with independent later communications is Pin&Go's
bounded recovery choice; it is not a provider guarantee of eventual delivery.
