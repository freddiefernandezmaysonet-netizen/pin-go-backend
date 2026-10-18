# Native Host incident actions

Part of the consolidated Host operational release; do not deploy this as a standalone store release.

Native GET /api/host-mobile/pin-ai/incidents/:reference advertises the four supported actions after canonical incident authorization. POST .../:reference/actions delegates ACKNOWLEDGE, NOTE, PUBLISH and RESOLVE to applyHostIncidentCommand without changing command parsing, version checks, request-id deduplication, transaction locks, encryption, audiences, commercial/canary scope, resolution evidence or channel outbox behavior.

The native routes require an explicitly signed bearer with a bound session, verify the current session in ENFORCE mode even if the web rollout is SHADOW, reject any Cookie or Origin header, and then retain canonical current-role and incident organization/property/reservation authorization. The existing cookie-authenticated web Origin protection is unchanged. No authorization bypass headers or new flag activation are introduced.

GET .../:reference/receipts/:requestId returns only acceptance metadata for the current actor, authorized canonical incident and exact request ID. Missing or unmatched receipts remain UNCONFIRMED; they never authorize automatic retransmission. Receipt lookup works after resolution. It does not decrypt or return private message content and does not certify provider delivery, guest reading or physical repair.

Validation: incident TypeScript; 13 local Host incident tests passed, including loopback signed-bearer/session/receipt/cookie-Origin checks. Two disposable PostgreSQL suites are skipped locally; the existing Host foundation workflow runs them and now includes persisted receipt/tenant assertions. No production database, real guest message, incident action, migration or runtime setting change was performed. UI dependency is in the existing Host operational draft PR7. Remote CI, controlled integration/deployment, environment readiness and device validation remain pending.
