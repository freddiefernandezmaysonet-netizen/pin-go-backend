# Pin AI automatic channel replies

This connects Channex `message` events to the existing Pin AI Guest Services runtime, agent configuration, guarded tools and property knowledge. Hosts do not approve routine replies. The reviewed draft control remains optional and independently disabled/enabled.

## Flow

1. `POST /webhooks/ota/channex/messages` authenticates a dedicated shared secret. Valid events map to exactly one READY local property/group/tenant in the activation allowlist.
2. Store message/thread identities in `ChannexAIInbound` before returning 202. Database failure returns 503 so Channex retries. Webhook text, booking ID and timestamp never authorize a reply.
3. Dedicated `src/workers/pin-ai-channex.process.ts` claims a durable per-thread lease and re-fetches the conversation through the tenant-checked inbox. Old, superseded and self messages do not receive replies.
4. Existing Pin AI runtime composes the answer using public knowledge for inquiries or the exact linked reservation's read context. No portal token/session is synthesized or reused. Reservation changes, proposals, payment/access mutations and incident notifications are not executed through this channel adapter.
5. Preserve the configured agent's response behavior. Like `guest-runtime-gateway.ts` in Manage Reservation, deliver `responseText` even when `requiresHumanReview` is true. This metadata does not pause the entire conversation or require host approval. Record it on the sent inbound outcome as `CHANNEX_ACCEPTED_REVIEW_REQUESTED`; no separate incident/email notification is claimed by this adapter.
6. Re-read the conversation and obtain an atomic dispatch fence. Send via the existing durable Channex receipt with a deterministic per-message key. No host click is required. Later guest questions continue in AUTO after a review-marked answer.

## Host intervention and delivery truth

Writing in the Pin&Go inbox pauses automation before the manual send. Explicit Take conversation / Return to Pin AI controls use host authentication, tenant scope and trusted Origin. Returning to AI sets a fresh boundary and processes only subsequent guest messages, not unanswered backlog.

A property-side Channex message after activation/resume which is not a known Pin AI receipt pauses automation. This includes replies sent directly in Airbnb/Channex and conservatively includes unrecognized operational messages. Pin&Go prevents a concurrent manual send after an AI dispatch has already been fenced: it pauses the thread, returns an in-progress notice, and asks the host to refresh before sending. A remote host reply can race a provider POST already in flight; one already-dispatched reply cannot be recalled. Do not promise instant cancellation of an in-flight OTA message.

The recent history window is 25 messages. If it cannot cover the activation/resume boundary, the thread pauses for review rather than assuming no host intervention. Attachments remain manual review. Provider acceptance is not delivery/read confirmation. A crash or uncertain response after the dispatch fence becomes `UNKNOWN` and pauses the thread; it is never automatically replayed. Model/read failures pause for host review. Expired pre-send leases can be reclaimed; stale owners cannot dispatch or finalize a newer claim.

## Controlled release and pilot scope

2026-10-03: original release deployed in backend #346/#347 and dashboard #184/#185. API, dedicated worker and property-only message webhook activated ONLY for Casa Collores (Channex `78c61f65-03a6-4f60-912e-507dd5c1464f`). General rollout remains pending in GitHub issue #348. The beds question received an automatic reply, confirmed in Channex and by Freddie in Airbnb. The next crib question exposed the adapter-only whole-thread pause. The response parity correction below removes that behavior; a new live multi-turn test is still required after its deployment.

For a thread already paused by the old review branch, verify its initial `PIN_AI_REQUIRES_HOST` event, current history, absence of a later host takeover or uncertain send, then explicitly resume the exact pilot thread using the normal control operation. Do not bulk-resume other properties or replay old messages.

Deploy the additive migration `20261003181000_channex_pin_ai_inbound` before enabling API or worker. Backend stacks on #346; dashboard stacks on #184. Existing automatic access-message feature remains separately controlled and its live test is pending.

Set the same scope on API and dedicated worker:

* `CHANNEX_HOST_INBOX_ENABLED=true` and the existing canonical Channex connection settings.
* `PIN_AI_CHANNEX_AUTO_ENABLED=true`
* `PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS=<verified local organization ID>`
* `PIN_AI_CHANNEX_AUTO_PROPERTY_IDS=<verified local Casa Collores property ID>`
* `PIN_AI_CHANNEX_AUTO_START_AT=<activation instant as UTC ISO string ending Z>`
* Existing `OPENAI_API_KEY` and `PIN_AI_OPENAI_AGENT_ID`.
* API: `PIN_AI_CHANNEX_WEBHOOK_SECRET=<unique random secret of at least 32 characters>`.

No wildcard scopes; maximum 50 IDs per list. Default OFF. Worker reference configuration: `railway.pin-ai-channex.json`. Production uses the explicit service start command `npx tsx src/workers/pin-ai-channex.process.ts`, because Railway's connector rejected the deprecated config-file setting. Do not reuse reservation-worker start configuration.

Register a property-scoped Channex webhook for the verified Casa Collores external property UUID. Use the documented `/api/v1/webhooks` API or Channex webhook UI, first checking for an existing identical endpoint/property registration. Settings: `event_mask: "message"`, `send_data: true`, `is_active: true`, callback `https://api.pin-ngo.com/webhooks/ota/channex/messages`, header `x-pin-go-channex-messages-secret` matching the API secret. Never print the secret in logs or PRs. Global registration can be considered after the pilot; the receiver already checks property scope.

Pilot must verify: new test guest message → one automatic response without host approval → duplicate webhook produces no duplicate → host takeover prevents another response → explicit resume handles a new message. Also verify a review-marked reply followed by another guest question continues automatically, and an uncertain-delivery fixture before expanding. Development tests are distinct from the scoped live pilot recorded above.

Rollback: stop the dedicated worker and disable the API feature; leave durable receipts/tables intact. An in-flight POST may complete once. Re-enable with a new activation boundary after reconciliation, never delete send receipts to force a retry.

Official source consulted 2026-10-03: https://docs.channex.io/api-v.1-documentation/webhook-collection (shared-secret authentication, message payload, retry and out-of-order delivery); https://docs.channex.io/api-v.1-documentation/messages-collection (thread history and reply API).
