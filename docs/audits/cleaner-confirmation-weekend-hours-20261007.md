# Availability dispatch: weekend and urgent-window audit

Source audit only; no runtime send-hour change or SMS.

`cleaning-confirmation-dispatch.service.ts` permits local hour >=8 and <18 every day. There is no weekday/weekend filter. Two tests executing its current hour function verify Saturday/Sunday 08:00 and 18:00 boundaries and independent property timezones. This is not proof of production runtime delivery.

Normal offers outside permitted hours remain pending. The only inspected bypass is explicit INTERNAL_DEMO authorization; real imminent cleanings have no urgency exception. A late booking with cleaning before the next permitted dispatch can therefore lack an opportunity to obtain cleaner acceptance in time. This finding applies weekdays too; it is not evidence that weekends are explicitly excluded.

The 120-minute fallback deadline derives from the oldest SENT Twilio log containing that exact confirmation token. Unsent offers are not expired merely because their reservation was created. A backup created after expiry is subject to the same allowed-hours gate. Acceptance independently validates the same SENT-based response expiry.

Pending proposals: host-configurable urgent dispatch behavior and a deadline-aware response/backup policy, retaining explicit acceptance, staff language and the existing availability family. Do not silently bypass hours, change 18:00 to 19:00, or add SMS families. The oldest-first 25-offer worker batch also deserves fairness review because skipped older offers remain eligible for selection.

No code correction is claimed here. Existing hours and provider integration are unchanged.

## Follow-up: dispatch batch fairness

A test executing the current processPendingCleaningConfirmations function with a fake repository reproduced a starvation path: 25 oldest PENDING offers on cleaning-NFC-disabled properties are selected and skipped repeatedly, while a later eligible offer is never inspected. The source query uses createdAt ascending and take 25 with no rotation/cursor or eligibility exclusion. Out-of-hours/cooldown skip reasons can similarly occupy batches. This is not evidence that this exact condition caused the user's historical missing weekend SMS.

A narrow correction should rotate through pending offers using stable createdAt/id ordering, or prefilter eligibility without losing fallback processing. It must preserve accepted/rejected status, existing send hours, exact-token duplicate protection and real dispatch cooldown. No SMS or runtime dispatch correction was made in this audit. Three hours/batch audit tests passed.

## Local correction: pending queue traversal

The dispatcher now traverses pending offers in pages of 25 using a stable createdAt/id keyset boundary. Skipped older offers no longer stop inspection of later offers in the same run; status changes during fallback do not shift an offset. Existing fallback, send-hour, cooldown, duplicate and Twilio send functions are unchanged. The regression executes the dispatcher across equal timestamps and two runs, proving a later eligible offer is reached while disabled offers never call the sender. Three focused tests and the scoped cleaner-account TypeScript check passed. No real SMS, deployment or historical delivery-cause certification.
