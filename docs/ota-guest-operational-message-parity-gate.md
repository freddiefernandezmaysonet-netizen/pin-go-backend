# OTA guest operational messaging — delivery parity gate

Status: **BLOCKED FOR MERGE**. This is an audit of existing paths, not a delivery certification.

## Required behavior
- For Channex Airbnb and Booking.com, operational PRECHECKIN, GUEST_ACCESS_PASSCODE, CHECKOUT must use Channex message threads; never Twilio/Resend for these guest-facing types.
- Other OTA providers retain existing delivery behavior. Direct Booking and host/staff notifications are unaffected.
- No fallback to external SMS/email if a Channex thread is missing, closed, ambiguous, or provider outcome unknown.
- Persist an explicit skipped/blocked outcome and avoid queued/retry provider calls. Do not mark an unaccepted Channex send as SENT.
- Never use guest-supplied provider metadata for routing. Resolve persisted reservation source and Channex mapping.
- Maintain deduplication, tenant isolation, valid access grant and time-window checks.

## Existing code audit
- `src/channex-messaging/airbnb-access.service.ts` routes Airbnb only under exact pilot organization/property/reservation allowlists; not globally.
- `src/services/preCheckinSms.service.ts` and `checkoutSms.service.ts` fall back to Twilio when pilot routing returns null.
- `src/services/messaging.service.ts` access passcode SMS similarly falls back.
- `src/services/email-delivery.service.ts` routes selected Airbnb types, then may call Resend.
- `src/services/guest-journey-access-communications-bridge.policy.ts` creates guest access email on email presence and SMS on broad Channex eligibility.
- `src/workers/message.retry.worker.ts` and `src/services/guest-journey-communications-delivery-adapter.service.ts` require review for pending/retry deliveries.
- `src/channex-messaging/host-inbox.ts` supports sending replies via Channex, but this does **not** establish automated Booking.com operational messages.

## Merge gates
1. Implement a provider-neutral operational Channex dispatcher supporting Airbnb and Booking.com, with fail-closed thread mapping and provider-accepted receipt semantics.
2. Integrate every initial producer and retry/outbox route, including existing pending deliveries, before any provider call.
3. Add integration tests with fake Channex/Twilio/Resend for each type/provider and missing/closed/ambiguous/unknown thread; prove zero external provider calls for blocked OTA and unchanged allowed providers.
4. Compile backend, run focused and existing regression suites, review PR diff.
5. Only after successful staging certification, configure `OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS=AIRBNB,BOOKING_COM` and deploy in a controlled rollout. No live test sends without separate approval.

**Do not merge the present partial implementation**: suppression is wired to only a subset of paths and the Channex Booking.com operational dispatcher is not yet implemented.
