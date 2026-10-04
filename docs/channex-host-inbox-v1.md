# Channex host inbox V1

Base: installation PR #342, commit `df756bf1b6b2b92a1bd545ebeefcc46c0151b4ad`.
Branch: `agent/channex-host-inbox-v1`. Installation PR stays unchanged.

## Behavior

The separate `freddiefernandezmaysonet-netizen/pin-go-dashboard` repository contains
the current Messages screen. Its `agent/channex-host-inbox-v1` branch adds property selection,
paginated OTA conversations and message history, and a plain-text reply composer.
The embedded dashboard copy in this backend is not the active application; the
initial UI edits there have been removed. The current delivery log remains available.
Messages are fetched from Channex on
selection or refresh; this version does not ingest messaging webhooks or run Pin AI.
Airbnb inquiries without a booking are supported through message threads.
Closed threads cannot be replied to. Attachments are counted in the history;
viewing/downloading and uploading attachments are outside this text-reply version.

## Official sources checked October 2, 2026 (Puerto Rico)

- https://docs.channex.io/api-v.1-documentation/messages-collection
- https://docs.channex.io/api-v.1-documentation/api-reference

Channex documents `GET /api/v1/message_threads`, thread detail and
`GET/POST /api/v1/message_threads/:id/messages`. Reply payload is
`{"message":{"message":"text"}}`. General API filtering uses
`filter[property_id]`; pagination uses `pagination[page]` and `pagination[limit]`.
The client verifies every returned property/thread relationship, even with a
property filter. Supported channels are Booking.com, Airbnb and Expedia;
Expedia Partner Solutions bookings do not support Messages. The inquiry example
uses `AirBNB`, so provider checks normalize case.

## Dashboard API

All paths start with `/api/dashboard/channex-messages`.

| Method | Path | Response |
|---|---|---|
| GET | `/properties` | Local property IDs/names with canonical READY mapping (maximum 1000) |
| GET | `/properties/:propertyId/threads` | `items`, `page`, `limit`, `total` |
| GET | `/properties/:propertyId/threads/:threadId/messages` | `thread`, `items`, `page`, `limit`, `total` |
| POST | `/properties/:propertyId/threads/:threadId/messages` | `message`, `replayed` |

GET collections accept `page` (default 1) and `limit` (default 25, maximum 100).
POST accepts only `{"text":"..."}`, 1–5000 characters, and requires
an `idempotency-key` header (8–120 characters). A successful reply means Channex
accepted it; it does not certify guest delivery.

## Security and duplicate prevention

- Session authentication is required, with `ORG_ADMIN`, `ADMIN` or `PLATFORM_ADMIN`.
  STAFF access is not enabled in V1.
- Organization comes exclusively from the authenticated session. Local mappings
  require an ACTIVE same-organization property and READY same-organization group.
- Thread detail must belong to the mapped remote property before message reads or
  writes. Every message must belong to the requested thread. Invalid collections
  fail closed. No raw provider bodies or transport errors are returned.
- POST requires an exact trusted Origin using the existing Connection Center
  tenant-origin policy. Responses are `no-store`.
- The unique database receipt `(organizationId, requestKey)` is created before
  contacting Channex. A fingerprint binds property, thread, text and actor.
  A matching SENT receipt replays its stored result; a changed request conflicts.
  PENDING and UNKNOWN receipts never issue another POST. There is no automatic
  retry after an uncertain provider outcome or receipt persistence failure.
- Browser query caches and session storage keys include organization and actor.
  After failure the same pending text/key is retained and automatic sending stops.
  Refreshing the history does not resolve a receipt automatically. Operator
  reconciliation for UNKNOWN receipts is a later feature.
- Transport uses only app/staging Channex origins, constrained messaging paths,
  a 15-second request timeout, a 1MB response cap and no redirects. The existing
  production configuration resolver forbids staging in production.

## Activation order (not executed)

1. Review the migration `20261003010000_channex_host_message_send` and apply it
   to staging before enabling the inbox. It creates only a new receipt table.
2. Deploy the reviewed backend and `pin-go-dashboard` changes to staging.
3. Configure the existing canonical Connection Center credentials and set
   `CHANNEX_HOST_INBOX_ENABLED=true`. Default behavior remains disabled.
4. Use a staging property with the Channex Messages application installed.
   Verify listing, an Airbnb inquiry, booking messages, a deliberate host reply,
   repeated identical request key, and cross-organization rejection.
5. Review staging evidence before production activation.

Turning off `CHANNEX_HOST_INBOX_ENABLED` stops inbox API access. Retain receipts
across rollback and restarts. Do not delete an uncertain receipt to retry a send.
No real property, guest message, migration, merge or deployment was performed.

## Validation

- 46 local tests pass for messaging installation, inbox, runtime adapters,
  authorization and frozen certified core.
- 39 additional Connection Center, route-order and runtime-import regression
  tests pass. These suites overlap in installation regression coverage.
- Six real PostgreSQL test results now pass: the SQL migration and status constraint,
  12 simultaneous replies through two Prisma clients producing one provider POST,
  reconstruction and persisted replay, conflicting text, UNKNOWN and PENDING recovery.
  The test creates and drops only a randomized schema in an explicitly local test
  database. Channex transport and property inventory remain synthetic.
- Eight dashboard interaction/delivery-history tests pass in the separate current
  dashboard repository. The branch disables automatic Vercel deployment.
- Strict messaging module and frontend inbox typechecks pass. Route checking
  uses the existing API convention with `exactOptionalPropertyTypes=false`, since
  shared authentication sources do not satisfy that optional-property setting.
- Backend ESM bundle and dashboard production Vite build pass.
- The earlier full dashboard typecheck finding applied to the embedded copy,
  not the current dashboard. The current inbox has its own strict typecheck and
  real React DOM interaction tests; its full Vite production build is also checked.
- No Channex staging send or browser visual test has run. The backend workflow
  now provisions PostgreSQL 18 for the database tests.

Pin AI can later consume normalized thread/message data and use this controlled
send boundary after its own authorization and reconciliation policies are added.
