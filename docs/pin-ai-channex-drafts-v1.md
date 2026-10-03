# Pin AI in the Channex host inbox: reviewed drafts

First host-facing integration of the existing Pin AI runtime with Channex threads. This release reduces typing while retaining explicit host review and manual send. It is not autonomous guest messaging.

## Host flow

For enabled properties, open an unanswered conversation and select **Sugerir respuesta con Pin AI**. Pin AI reads the latest 25 messages from Channex and the property's knowledge. The host sees a separate unsent suggestion, can discard it or copy it into the editable composer, then use the existing Send action. Draft generation never calls Channex POST, creates a send receipt, or changes a reservation. Existing manual-send idempotency remains unchanged.

`POST /api/dashboard/channex-messages/properties/:propertyId/threads/:threadId/pin-ai-draft` accepts only `{messageId}`. The authenticated organization, trusted Origin and existing Channex property/thread relationship verification are required. The server reads the actual text, never an injected browser prompt or booking ID. It rechecks history after generation and rejects changes, closed threads, already-answered questions, unsupported channels, attachments and oversized context.

## Context and runtime

Reuses Pin AI's guarded Luna/Agents transport, shadow orchestrator, property knowledge and read executors. Each draft gets a fresh isolated provider session; portal conversation sessions and guest credentials are not reused. Tools cannot write proposals, incidents, messages, payments, access or reservation changes. Escalation is a review indication, not a notification.

An inquiry without a booking gets public property knowledge only. `unlinked-channex-inquiry:<threadId>` is an isolated runtime conversation namespace, never a database reservation identifier; all reservation tools are blocked before reaching the read executor. The model receives an explicit inquiry-without-reservation context. Booking threads resolve exactly one active local reservation by CHANNEX external booking ID, property and authenticated organization. Missing or ambiguous links fail closed. Visibility rules continue to govern confirmed-guest and during-stay knowledge.

Generation is capped at 60 seconds, 60 network calls, 8 concurrent drafts per API process and one per conversation per process. No automatic retry. A provider failure leaves the manual composer available. Distributed rate limiting and persistent AI audit history are future work; this scoped pilot is deliberately host initiated.

## Activation

Default OFF. API environment requires all three:

* `PIN_AI_CHANNEX_DRAFT_ENABLED=true`
* `PIN_AI_CHANNEX_DRAFT_ORGANIZATION_IDS=<exact local organization IDs>`
* `PIN_AI_CHANNEX_DRAFT_PROPERTY_IDS=<exact local property IDs>`

Each allowlist permits at most 50 IDs and no wildcard. Existing `CHANNEX_HOST_INBOX_ENABLED`, Channex configuration, `OPENAI_API_KEY` and `PIN_AI_OPENAI_AGENT_ID` must be configured. No worker settings, migrations or webhook registrations are needed. Deploy backend before dashboard; activate a verified Casa Collores local mapping for the first reviewed draft. Do not infer its local ID from its Channex UUID. Rollback: turn `PIN_AI_CHANNEX_DRAFT_ENABLED` off; manual messaging continues.

## Verification and remaining steps

Focused tests cover tenant scope, exact reservation lookup, disabled configuration, concurrent drafts, stale/answered/closed conversations, attachments, read-only inquiry tools and a separate host-reviewed send. Existing runtime/property knowledge regression tests, inbox typechecks, API bundle and dashboard build are required. No model generation or guest send is performed by the test suite.

Production activation and a live reviewed draft remain pending. Automated replies require a later authenticated `message` webhook, durable inbound deduplication, host takeover and escalation handling. Live automated access-message certification remains separately pending an appropriate reservation.

Official references (consulted 2026-10-03):
* https://docs.channex.io/api-v.1-documentation/messages-collection
* https://docs.channex.io/api-v.1-documentation/webhook-collection — events can arrive out of order; retrieve authoritative state before responding.
