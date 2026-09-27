# Pin AI Guest Incidents V1

Implementation candidate, 2026-09-27. Not a production certification.

## Verified baseline and authorization

Audited backend main: `e17b394996bca67464ba42f6814f199f8160e305`.
Railway backend deployment `63bcf380-2c18-477b-828c-408eefaee498` was
verified SUCCESS on that SHA. The user authorized incident/notification
implementation and tests. Ready, merge, deployment, configuration changes and
live notification remain separate approval gates. No production sends or
configuration changes were performed while implementing this candidate.

## Scope

Guest reports become durable `OperationalIssue` records, projected through the
existing HOST Mission Control query. A transaction creates the case, transition
and `MessageLog` outbox entries together. The existing operational upsert can
now participate in that transaction; existing callers keep their own transaction.
No migration or new independent operational engine is introduced.

`escalate_to_host` supports REPORT and STATUS only inside the incident canary.
There is one open case per reservation/category. Repeated reports update its
guest evidence without sending another initial notice. Different categories are
separate; REPORT after canonical resolution creates a new recurrence. STATUS
never writes a case or reopens one. OTHER deliberately groups uncategorized
reports in one open case; finer issue classification is future work.

The server verifies token expiry, active reservation/property, checkout and
organization/property/reservation scope on every operation. Guest quotes must
occur in actual guest messages from bounded persisted history or the current
request. Assistant troubleshooting suggestions are not evidence of completion.
The case is explicitly a guest report, not a verified diagnosis.

Only active ORG_ADMIN, legacy ADMIN, or PLATFORM_ADMIN recipients belonging to
the reservation's organization receive notices, matching the existing
requireOrgAdmin role policy. PLATFORM_ADMIN in another organization is never a
fallback recipient. The same scoped predicate is used for enqueue and delivery.
Model arguments cannot select recipients or scope. Recipients
and canonical scope are rechecked before each send. The bilingual, escaped email
links to authenticated Dashboard and conveys no approval credential or authority.

## Delivery and truthful receipts

The message retry worker processes this new communication type only when the
notification flag and reservation allowlist permit it. The initial state is
QUEUED. Compare-and-swap claims protect concurrent workers, with a 90-second
lease. A fixed provider idempotency key and immutable report payload cover
ambiguous failures and worker restarts. Four attempts are bounded with 1/5/15
minute backoff. No uncertain replay occurs after 23 hours. Provider calls time
out after 20 seconds; no console-only success counts as acknowledgement.

Provider acceptance, delivery, host acknowledgement and repair are distinct.
Existing signed delivery-webhook handling correlates provider IDs with MessageLog.
Rebounds/suppression/complaints/terminal provider failures require attention,
not blind resend. Absence of delivery evidence after one hour requires attention
without asserting that delivery failed or resending an uncertain email. Late
confirmed delivery can still be reflected in the guest receipt.

Failures remain visible in Mission Control. Delivery does not resolve the
underlying service incident. Missing recipients likewise yield attention required.
This release does not implement host dialogue, human acknowledgement, a repair
workflow, a new case-resolution UI, host approval or configurable supervisor
permissions. STATUS reports only the persisted canonical resolution state.

For incident calls the application returns a server-rendered localized receipt,
not an unverified model completion claim. The gateway requires matching private
runtime evidence before accepting an operational write and persists the receipt
in existing encrypted conversation history. The legacy `mode: SHADOW` and
`actionsExecuted: false` compatibility fields still describe the absence of
canonical reservation/payment/access execution; `operationalWrites`,
`escalationCreated` and `incident` expose the bounded incident effects explicitly.
Response safety checks stay active even when escalationCreated is true.

## Default-off configuration (not applied)

- `PIN_AI_INCIDENT_ENABLED=true`
- `PIN_AI_INCIDENT_CANARY_RESERVATION_IDS=<explicit reservation IDs>`
- `PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED=true` on the message worker to send
- Existing `APP_URL` must be HTTPS; its origin is snapshotted when queuing

The backend and worker both need the scoped incident configuration. Blank,
invalid or absent allowlists disable operations. Turning notifications off
pauses queued work. Re-enabling preserves retry budgets and idempotency limits.
Outside the scope, the prior read tools, action canary and shadow escalation
remain unchanged. No settings above have been applied to Railway.

## Validation and remaining gates

Local tests cover transport gating, authoritative receipts, quote/input policy,
concurrent send claims, revoked recipients, retry budgets, crash-after-acceptance,
idempotency expiry, delivery failures, templates and existing runtime regressions.
The new CI workflow requires real PostgreSQL tests for atomic rollback,
concurrent incident deduplication, tenant isolation, history evidence, delivery
updates and recurrence. It also compiles the message worker and gateway.

Compiling the complete worker exposed five pre-existing main errors. Minimal
type-only corrections align two nullable MessageLog statuses with Prisma and
give the existing retry-pagination helper an explicit optional-property return
type. No Property Protection business behavior changes.

Before production certification: CI including PostgreSQL must pass; review the
exact diff; obtain Ready/merge/deployment/configuration approvals; verify one
authorized guest canary with Mission Control visibility, one real provider
acceptance and delivery, and guest history after reload. Verify the existing
webhook is configured and reachable in production. Provider acceptance alone
does not certify delivery. Health Center, Access, Stripe, OTA and Supervisor
configuration remain outside this implementation.
