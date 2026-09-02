# Pin&Go Enterprise Reviews E1

Enterprise Reviews E1 is additive and disabled by default. It covers verified
Direct Booking stays, guest submission, evidence-based moderation, public
reputation, host responses/disputes and an append-only decision history.

## Runtime controls

Backend:

- `PINGO_REVIEWS_E1_ENABLED=true`
- `PINGO_REVIEW_AUTO_PUBLISH_ENABLED=false`
- `REVIEW_TOKEN_ENC_KEY_BASE64=<32-byte key encoded as base64>`
- `APP_BASE_URL=https://app.pin-ngo.com` (or the canonical dashboard origin)

Invitation worker (configure before enabling the dispatcher):

- `PINGO_REVIEW_INVITATION_DISPATCH_ENABLED=false`
- `PINGO_REVIEW_INVITATION_ELIGIBLE_AFTER=<timezone-explicit ISO timestamp>`
- `PINGO_REVIEW_INVITATION_POLL_MS=300000`

Dashboard:

- `VITE_PINGO_REVIEWS_E1_ENABLED=true`

If the backend flag is enabled without a valid encryption key, startup fails
closed. Generate a new key in the secret manager with `openssl rand -base64 32`.
Never log, commit or place this value in a client-side environment variable.

For key rotation, configure a keyring and an active key instead of replacing a
key in place:

- `REVIEW_TOKEN_ENC_KEYRING_JSON={"v1":"<old-base64>","v2":"<new-base64>"}`
- `REVIEW_TOKEN_ENC_ACTIVE_KID=v2`

New invitations use the active key ID. Existing invitations remain decryptable
while their previous key stays in the keyring. Remove an old key only after all
invitations encrypted with it have expired or been consumed. The legacy single
key variable remains readable as key ID `v1` during migration.

The backend and dashboard flags must remain `false` until the migration and
staging certification have completed. Auto-publication remains independently
`false` until a content-safety provider has been integrated and certified.

## Invitation and email contract

Reservation confirmation never creates, contains, retries or delivers a review
invitation. A dedicated, independently disabled dispatcher selects only paid,
active canonical Pin&Go Direct stays at least 24 hours after checkout. This
boundary prevents any Reviews failure from blocking or replaying Reservation.
The dispatcher additionally requires a timezone-explicit launch cutoff and
selects only reservations whose checkout is on or after that instant. Missing,
ambiguous or invalid cutoff configuration fails closed before the worker starts,
preventing an accidental historical campaign. Any intentional backfill requires
a separate audited workflow and authorization.
The invitation is bound to the normalized guest email by a SHA-256 hash and the
delivery fence revalidates the canonical recipient immediately before sending.

The browser link uses `/review#token=...`. URL fragments are not sent to the web
host. The dashboard sends the token to the API using the dedicated
`Authorization: ReviewToken ...` scheme. The database stores a SHA-256 lookup
hash and AES-256-GCM ciphertext, never the plaintext token. Email retry payloads
also exclude the token; a retry reconstructs the message from canonical booking
data and rehydrates the token from the encrypted invitation. Once loaded, the
dashboard removes the token fragment from the visible address and browser
history. A full browser refresh intentionally requires opening the dedicated
post-checkout invitation email again.

Every provider attempt uses a stable invitation/token-generation idempotency
key. The plaintext bearer is excluded from durable retry payloads. Provider
acceptance is recorded against the fenced invitation generation.
`providerAcceptedAt` means the provider accepted the request; it does not claim
inbox delivery. Bounce and delivery webhooks remain a separate operational
concern.

The link expires 30 days after checkout and can create at most one native
review. Request authorization recalculates the boundary from the canonical
reservation, so a stale stored timestamp cannot unlock submission early.

## Publication policy

- By default, every submitted review enters moderation before publication.
- Clean 4–5 star reviews publish automatically only when the separately gated
  `PINGO_REVIEW_AUTO_PUBLISH_ENABLED=true` control is explicitly enabled after
  certification of the content-safety provider.
- 1–3 star reviews enter `PENDING_MODERATION`.
- Any rating with a safety signal enters `HELD_FOR_REVIEW`.
- Subjective negative opinion is not a rejection reason.
- `FACTUALLY_CONTRADICTED` requires a moderator to select a positive Pin&Go
  evidence record from the reservation, access, communications, Guest Journey
  or APMS audit snapshot.
- A published review must move to `HELD_FOR_REVIEW` before it can be removed.
- Hosts may respond or submit context, but cannot edit ratings, publish, reject
  or delete guest reviews.

Every review gets a moderation case/event, including automated publication.
Moderator writes use optimistic version fencing. Moderation events and host
response revisions are append-only at the database layer.

## Data and tenant invariants

- One `PropertyReview` and one `PropertyReviewInvitation` per reservation.
- Review, invitation and moderation case organization/property scope must match
  their canonical reservation/review. PostgreSQL triggers enforce this invariant
  on writes to Reviews-owned tables. The Reviews migration installs no trigger on
  `Reservation` or `Property` and cannot alter their existing lifecycle.
- Only `PUBLISHED` rows affect public totals, averages and lists.
- A public response reads rows, totals and averages from one repeatable-read
  database snapshot, preventing an internally inconsistent score/count payload.
- Audit-bearing review rows use restrictive foreign keys; deletion requires an
  explicit retention/anonymization workflow rather than an implicit cascade.
- Application services own review lifecycle writes. Production roles must not
  permit ad-hoc direct SQL mutations that bypass the corresponding event write.

## API surfaces

Public:

- `GET /api/public-reviews/invitation`
- `POST /api/public-reviews/submissions`
- `GET /api/public-reviews/property/:organizationSlug/:propertySlug`

Host:

- `GET /api/dashboard/reviews`
- `PUT /api/dashboard/reviews/:id/response`
- `POST /api/dashboard/reviews/:id/disputes`

Platform moderation:

- `GET /api/internal/reviews/moderation`
- `GET /api/internal/reviews/moderation/:id/evidence`
- `POST /api/dashboard/reviews/:id/moderate`
- `POST /api/dashboard/reviews/:id/response/moderate`

Public token endpoints are no-index/no-referrer and rate-limited. Authenticated
mutations require an active database-verified actor, rate limiting and a trusted
origin when ambient cookies are used. Custom brand origins are bound to the
actor's organization. The process-local limiter is a defense-in-depth fallback;
a distributed gateway/WAF limit is required before production activation.
Production CORS and mutation-origin allowlists exclude localhost; local origins
are added only outside `NODE_ENV=production`.

Host responses are safety-scanned before publication and every edit appends a
revision. A response already marked `HELD_FOR_REVIEW` or `REMOVED` cannot be
edited back to `PUBLISHED` by the host. A database-verified platform moderator
can hold, republish or remove a response only through the allowed state machine,
with an objective reason, a documented note and optimistic revision fencing.
Every such decision appends the exact response-body snapshot and actor to the
immutable revision history. Public reads expose only `PUBLISHED` responses.

## Certification commands

Backend:

```bash
npm run test:enterprise-reviews-e1
npx tsc -p tsconfig.guest-journey-enterprise-e7.json --pretty false
```

Dashboard:

```bash
npm run test:enterprise-reviews-e1
```

The migration must additionally be applied to a disposable PostgreSQL database
and exercised with real persistence, HTTP, tenant-isolation, concurrent
submission and concurrent moderation tests before production.

The database preflight must also verify trigger privileges, a locked-down
`search_path`, the migration-only partial index, and the explicit maintenance
workflow required by append-only guards. Do not use `prisma db push` as a
replacement for this migration.

Append-only guards protect existing moderation events and response revisions,
but the current parent rows are not tamper-proof against privileged direct SQL.
Production application roles must therefore be least-privileged and the real
PostgreSQL certification must verify that lifecycle writes cannot bypass their
corresponding audit insert. The scope trigger also relies on a trusted
`search_path`; activation requires fixing or strictly locking that database
setting and removing unnecessary schema `CREATE` privileges.

Automatic publication of clean 4–5 star comments requires a certified
content-safety control before production. The E1 regex fence is useful defense
in depth, but is not a comprehensive moderation provider and must not be treated
as one. `PINGO_REVIEW_AUTO_PUBLISH_ENABLED` is therefore default-off and every
submitted comment routes through the moderation queue until that independent
control is explicitly enabled.

The application-level limits must be backed by a distributed rate limit/WAF
policy before enabling more than a single controlled instance.

A security audit identified a pre-existing legacy `/reservations` boundary.
It predates Reviews and its public mounts are removed locally as a separate
security change after repository-consumer and Railway traffic review. The
authenticated `/api/dashboard/reservations` boundary remains unchanged.
The Reviews migration installs no trigger on `Reservation` or `Property`;
scope enforcement runs only on Reviews-owned tables so existing reservation
and property operations retain their current behavior.
Reviews must not treat a generic reservation email change as authority to
redirect or reissue a review invitation; recipient reissue requires a dedicated
authenticated workflow.

## Safe rollout

1. Keep both feature flags off.
2. Back up and apply the additive migration in staging.
3. Configure the encryption key and deploy backend code with the flag off.
4. Deploy dashboard code and verify the public `/review` route with its flag
   off.
5. Run staging email, checkout-time, moderation, public reputation and tenant
   isolation certification.
6. Enable and verify the dashboard receiver first; only then enable the backend
   email emitter under monitored rollout. This prevents sending links before a
   working guest route is available.

Rollback is flag-first: disable dashboard and backend. Preserve the additive
tables and audit history; do not down-migrate review data during an incident.
