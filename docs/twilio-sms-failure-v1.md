# Twilio SMS failure V1 — policy foundation

## Status and scope

Draft implementation based on main `e9df89176a564a7f68e23c8cd02a539fcde065ee`.
This first slice adds a pure decision policy, 61 offline tests and an isolated
TypeScript/CI configuration. It is **not mounted** in the webhook, retry worker,
provider adapter or Mission Control persistence. No deployed behavior changes.
A returned hostAction is a persistence plan, not an incident already created.
A returned blockAutomaticReplay is a decision, not an enforced runtime fence.

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
- UNDELIVERED or FAILED with exact 30005 blocks unattended replay for this
  attempt pending review. This does not permanently invalidate the phone.
- Inconsistent status/error evidence requires internal review, not a fabricated
  delivered result or automatic send authorization.
- Only PRECHECKIN and GUEST_ACCESS_PASSCODE for the same active reservation,
  property and organization, before checkout, produce a host-action plan.
  The action links to the reservation. Access-message failure is critical;
  arrival-message failure is a warning. No lock failure is inferred.
- Checkout, cleaner, marketing, untyped or other messages do not create a guest
  arrival/access action. Their typed operational policies remain separate work.
- Missing/mismatched scope, correlation or dates fail closed.
- Key identity includes both messageLogId and the exact Twilio Message SID.
- An existing scoped workflow owns recovery; duplicate receipts do not reopen
  resolved actions or replace WAITING/AUTO_RESOLVING with a new host action.
- Metadata is allowlisted: no destination number, SMS body, guest token, access
  code, provider error free text or credentials.
- No fallback, provider request, email, SMS, database write, reservation edit,
  access operation or permanent destination blacklist occurs in this module.

A false blockAutomaticReplay is NOT permission to send. Existing consent,
expiration, destination, template, idempotency and other error policies apply.
The input must come from trusted persisted evidence after signature validation;
this pure function neither authenticates a webhook nor performs tenant lookup.

## Validation

Local strict TypeScript with exactOptionalPropertyTypes and
noUncheckedIndexedAccess passes. All 61 compiled JavaScript policy tests pass
under Node 22.16.0. No database/provider mocks are being represented as real
PostgreSQL, Twilio, signed HTTP, deployment or hardware certification.
The new workflow runs the locked repository compiler, emits the same tests and
runs them without Prisma lifecycle scripts, a database or provider credentials.
Remote validation must be reported against the actual published head.

## Next integration gates — not implemented here

1. Bind a signature-validated callback to exactly one persisted provider SID and
   load its current reservation/property/organization. Handle callbacks arriving
   before send-result persistence, unknown or duplicate SID mappings, out-of-order
   receipts and missing error fields without silently losing terminal evidence.
2. Persist delivery evidence and its operational transition safely, with actual
   PostgreSQL concurrency/rollback/replay tests. An old callback must not update
   a newer send attempt. Reconciliation must survive persistence failures.
3. Enforce the replay decision in the active SMS retry path. Audit manual resend
   and APMS communications-owner paths too. Never replay masked log bodies or
   obsolete access instructions; do not send anything in callback handling.
4. Wire host visibility and a real resolution action. Do not advertise automatic
   email or OTA messaging fallback before that route and its delivery are tested.
5. Configure the existing delivery callback securely on all sending runtimes:
   MESSAGE_DELIVERY_WEBHOOKS_ENABLED=1, TWILIO_AUTH_TOKEN and a consistent public
   HTTPS API base. Under the current client, senders require the token to attach
   the callback even though they use API-key credentials for sending. Never put
   the Auth Token into chat, source, CI or logs. API and workers deploy separately.
6. Run an authorized live canary and prove DELIVERED or UNDELIVERED/30005 plus
   correct host action and no duplicate SMS. Reconcile this historical incident
   explicitly; enabling future callbacks does not by itself backfill old receipts.

No merge, deployment, persistent database change, configuration change, live
provider call, real guest SMS or production activation is authorized by this
Draft. Existing branch protections and certification allowlists remain intact.

## Primary provider documentation reviewed

- https://www.twilio.com/docs/api/errors/30005
- https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
- https://www.twilio.com/docs/usage/webhooks/webhooks-security

Twilio lists multiple possible causes for 30005 and recommends controlled
troubleshooting. The no-unattended-repeat choice is Pin&Go's conservative policy,
not a claim that Twilio defines every 30005 as permanently non-retryable.
