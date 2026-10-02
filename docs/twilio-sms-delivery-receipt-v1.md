# Twilio delivery receipts and critical missing-email communication gap

## Draft integration scope

Continues PR #341 after `c104fdeafddabaf6eeb1ea13683e14566bc42dd6`.
That predecessor's ten reported PR workflows passed, including the dedicated
PostgreSQL migration/registration/claim and access-gap projection suites. This candidate needs its own CI.

The existing Twilio webhook now has an explicit default-off integration path.
SDK signature verification still happens first and includes every form field.
The new path additionally verifies the configured AccountSid and consistent SMS
SID aliases. Resend processing and the old path with the new flag off are unchanged.

A new additive receipt inbox retains only account/SID/status/error/timestamps and
processing identity. Its deduplication digest does not include receipt time; a
repeated callback cannot restart the failure anchor. It retains early/unmatched
and ambiguous receipts. An internal exact-receipt reconciler can map early
receipts later; no automatic inbox sweep is started by this slice.

After retaining the inbox receipt, a transaction locks the source and existing
retry identity, revalidates exact SID mapping and scope, calls the existing
recordMessageDeliveryOutcome, registers eligible recovery in the existing store,
and invokes the existing persistTwilioSmsAccessGap projector, which revalidates
active grant/lock evidence and persists through upsertOperationalIssue. The
projector now accepts an existing transaction; its standalone behavior and tests
are retained. Its journal read uses parameterized SQL, avoiding a dependency on
new generated model delegates in existing single-schema typechecks.
The shared outcome function accepts its actual minimal messageLog dependency so
it can participate in this transaction; its implementation is unchanged.

The original MessageLog status, SID and retry count remain unchanged. Late SENT
cannot overwrite terminal failure. Missing ErrorCode on repeated failure cannot
clear the stored code or postpone the anchor. Conflicting success/failure is
retained as CONFLICT and an unclaimed retry is put in REVIEW, not auto-replayed.

GUEST_ACCESS_PASSCODE + 30005 + no current guest email produces a HOST-visible
CRITICAL ACTION_REQUIRED workflow. Its distinct GUEST_ACCESS_SMS_GAP identity
is not the retry owner's identity; it does not consume the retry budget or block
a future approved claim. No lock, passcode, reservation date or access state is
changed. Duplicate callbacks preserve an existing issue, including RESOLVED.
No guest phone, SMS body, access code or provider free text enters issue metadata.

The first transaction retains the receipt even if the second transaction fails.
Outcome, journal registration, issue and history then roll back together; a replay
can retry the projection without sending another message.

## Configuration: explicit future rollout only

The API receiver requires the existing MESSAGE_DELIVERY_WEBHOOKS_ENABLED=1,
TWILIO_AUTH_TOKEN and consistent HTTPS API base, plus the correct TWILIO_ACCOUNT_SID.
The new path additionally requires TWILIO_SMS_RECOVERY_ENABLED=1,
TWILIO_SMS_RETRY_DELAY_MINUTES (integer 1..1440) and
TWILIO_SMS_MINIMUM_SPACING_MINUTES (integer 1..60). There are no live defaults.
The tests use 30 and 15 minutes only as fixture configuration.
Generate/validate the full multi-file Prisma schema and apply both additive
journal/receipt migrations before enabling this path. API and SMS-producing
workers have separate deployment/configuration gates. No setting was changed.

## Explicit remaining gates

- Actual bounded retry dispatcher with fresh consent, current content/recipient,
  access-release and validity checks, reconstructing content rather than replaying
  masked logs; legacy/manual/APMS send ownership must be coordinated before rollout.
- Automated bounded inbox reconciliation, retry-SID outcome processing, YIELDED
  next-message result handling and crash/unknown-result recovery. A retry SID not
  present in MessageLog is retained UNMATCHED, not claimed as delivered.
- Host notification delivery, bilingual UI/host resolution action and exact
  successful-retry resolution. This slice persists canonical host-visible data;
  it does not certify the Dashboard or send an alert email to the host.
- Existing-email-but-undelivered and other missing-channel cases need their own
  evidence logic. Email presence is not delivery proof; this issue specifically
  covers missing email. No email/Airbnb fallback is implemented.
- Production runtime generation/configuration, authorized live canary and explicit
  historical-message reconciliation. Nothing retroactively fixes the live SMS.

## Validation boundaries

The new tests refuse any database except the exact loopback disposable CI URL
and require TWILIO_RECOVERY_DISPOSABLE_DB=1. They exercise real PostgreSQL, the
existing OIE transaction/history, SDK-signed loopback HTTP, duplicate and late
callbacks, early receipts, bad scope/account/signature, rollback and independent
retry ownership. No provider API/hardware call, real guest SMS or email is used.
Local work validates syntax only: this execution container has no repository
runtime dependencies or PostgreSQL. Full scoped TypeScript, schema migration,
database tests and retained contracts must pass in CI before this candidate is
represented as validated. No branch protection or scope gate is relaxed.

Provider basis: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
and https://www.twilio.com/docs/usage/webhooks/webhooks-security.
Twilio documents out-of-order callback arrival and recommends SDK signature
verification. The retry limits and host escalation are Pin&Go policy decisions.


## Bounded inbox continuation and retry SID outcome — candidate

The next slice adds durable delivery fields for the one retry attempt without
rewriting the original MessageLog. A callback for retryProviderMessageId is
matched to TwilioSmsRecovery, keeps original and retry SIDs separate, and records
retry delivery status/error/time. Confirmed retry delivery moves the journal to
DELIVERED; terminal retry failure moves it to REVIEW and cannot restore the
single consumed retry budget. Contradictory terminal provider evidence is kept
for review rather than silently flipped.

Early callbacks may race the persistence of the retry SID. They remain UNMATCHED
in TwilioSmsDeliveryReceipt. A bounded inbox reconciler claims due unresolved
receipts with PostgreSQL FOR UPDATE SKIP LOCKED, increments the durable attempt
counter before processing, schedules the next attempt, and eventually marks
unresolved evidence RECONCILIATION_EXHAUSTED. It performs no provider request and
sends no SMS. Multiple consumers partition the due batch instead of multiplying
attempts.

Reconciliation is separately gated and has no production defaults. Interval,
maximum age, maximum attempts and batch size must all be explicitly configured.
This slice does not mount a worker loop or the real retry dispatcher. A retry
journal claim remains evidence of an owned opportunity, not authorization to
send. Host resolution after an exhausted PRECHECKIN retry and the actual fresh
content/consent/access-readiness dispatcher remain later gates.
