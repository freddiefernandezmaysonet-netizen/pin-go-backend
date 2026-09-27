# Pin AI — Host Incident Conversations V1

Design candidate, September 27, 2026. No runtime implementation or activation.

## Verified starting point

- Backend main: `fd93534541b6648ef31679c5b521ed0af7f7f728`.
- Dashboard main: `d37822e832800c92b23cd1aa2efbc3872fb1db62` (source audit; no new Vercel deployment audit).
- Railway backend deployment `6c94693f-e093-471c-881c-cc668dfea0ba`: SUCCESS on that backend commit.
- Guest incident canary enabled exclusively for PG-2026-000051, internal reservation `cmucz3owr0005n015intsxvmz`.
- GI-A2D58EB9A0D2: provider delivery verified, guest status reflects delivery; user supplied Mission Control evidence and confirmed guest history survives reload. Incident remains unresolved. This certifies the tested guest reporting path, not a host conversation or repair workflow.
- Existing `OperationalIssue` and transitions own incident state. `PinAIGuestConversation` is reservation-scoped with encrypted guest history. They are not interchangeable.
- `PropertyCalendarPage.tsx` displays Mission Control. Current notice links to the property calendar. A direct host incident thread route must be implemented before using it in emails.
- `resolveOperationalIssuesForReservation` resolves multiple reservation issues. Never use it as the host thread's single-case close operation.

## Agreed product direction

One conversation center per organization, with one internal thread per incident.
Email is a notification leading to the authenticated Dashboard. Guest and host
conversations remain separate. No mailbox or inbound-email automation is required
for this first release. A dedicated sender address remains a separate DNS/provider
configuration task; keep the verified sender until separately approved.

The host sees property, reservation number, incident reference, reported facts,
delivery status, responsibility and resolution state. Filters: property, open vs
resolved and unread activity. Detail contains chronology, internal conversation,
guest-visible updates and explicit case actions. Use localized product labels,
not raw engine names or enum values. Preserve an entry point from Mission Control.

## First release: bounded host coordination

1. Email and Mission Control open the exact incident thread. If sign-in is
   required, resume a validated internal path after authentication; never accept
   arbitrary external return URLs or treat possession of the email link as access.
2. Host speaks to Pin AI within that incident. Pin AI can read the scoped case,
   relevant reported facts and host thread; summarize, ask questions, and draft
   next steps. It cannot claim a technician was contacted or a repair completed
   without evidence.
3. Explicit “Take ownership” records authenticated host acknowledgement, distinct
   from email delivery, page view and resolution. Opening a thread alone is not
   acknowledgement.
4. Host may prepare a guest update. Show its exact text and require an explicit
   “Share with guest” action. Persist a distinct guest-visible event; do not copy
   internal thread history or model-generated summaries automatically. A guest
   update appears on the next authorized portal fetch/reload, without claiming
   push delivery or that the guest read it.
5. Explicit “Mark resolved” requires an outcome note, current case version and
   authenticated authority. Record who reported resolution and when. The guest
   sees “host marked resolved”, not independent verification of the physical fix.
   A new guest report after closure follows existing recurrence semantics with
   a new incident and thread; the previous history stays intact.

V1 includes the real AI host conversation, acknowledgement, controlled guest
updates and single-incident closure. It does not include purchases, refunds,
reservation changes, access/device operations, contacting technicians, attachments,
autonomous deadlines, or execution approvals for other engines.

## Persistence and state ownership

Proposed new thread/message storage, reviewed through a migration before release:

- Thread: unique operationalIssueId, organization/property/reservation scope,
  assignment/acknowledgement metadata, version, timestamps and AI turn lease.
- Message: thread, server-assigned sequence, author type and authenticated user
  when applicable, bounded content, client request id and creation timestamp.
  Unique (thread, client request id) prevents duplicates from retries.
- Read cursor: user plus thread and last seen sequence. Read status is separate
  from taking responsibility.
- Guest update: explicit published content, incident reference, actor, timestamp
  and stable event id. Separate from internal messages. Integrate read projection
  into the existing guest history endpoint without overwriting encrypted history.

Create/materialize one thread per existing eligible incident idempotently, so the
certified incident can be used without re-reporting or resending its initial email.
Opening a thread must not close, reopen or duplicate the incident. Store host
content with defined encryption/key handling and retention before implementation;
do not derive host-thread encryption from guest bearer credentials.

OperationalIssue remains the sole resolution authority. Acknowledge, publish and
close operations use scoped transactions, optimistic version checks, idempotency
and audit entries. Closing one issue cannot affect other incidents, their notices
or other reservations. Reuse canonical transition semantics with a scoped
single-issue service, not a parallel status in the thread.

AI turn persistence must survive refresh and handle two host sessions: one lease
per thread, durable pending/completed/failed turn states, retry without duplicating
messages or published effects. Commit side effects separately from model text;
return server receipts for actions. Logs contain correlation ids and error codes,
not guest tokens, full conversations or credentials.

## Authorization and audience boundaries

Every list, detail, send, AI read/tool, acknowledgement, publish and close request
reauthorizes the active Dashboard account and exact organization/property scope.
V1 allows the existing organization administrator roles ORG_ADMIN, ADMIN and
PLATFORM_ADMIN only within their own organization. No cross-tenant fallback.
MEMBER and staff delegation require a later explicit permissions design.

Derive scope and actor from the authenticated server context, never model input.
Check relationship consistency between incident, reservation and property.
Unauthorized ids return no case or recipient information. Revocation must take
effect on the next operation, including queued AI work. Guest tokens cannot read
internal threads; guest projections contain only explicit guest-visible events.
Host-scoped access to incident history must remain possible after guest checkout,
subject to retention policy; it must not extend guest token validity.

Treat guest and host free text as untrusted content, not permission grants. Tool
allowlists and server policy enforce limits independently of prompts. API routes
should be scoped under the existing authenticated dashboard boundary; proposed
UI route `/pin-ai/incidents/:reference` is not currently a production route.

## Future supervisor and configurable permissions

Keep guest agent, host coordination agent and canonical execution distinct.
The supervisor may later coordinate deadlines, assignments and action proposals
under a versioned host-configured policy: allowed capabilities/properties,
spending caps, approval thresholds, escalation contacts/timing and pause controls.

An approval binds authenticated actor, exact action and parameters, organization,
property, reservation, price/currency where relevant, policy version and expiry.
Revalidate current role, policy and execution prerequisites before dispatching to
the existing canonical engine. A chat “yes”, email reply, model confidence or
supervisor role label grants no independent execution authority.

## Delivery plan and gates

1. Backend foundation: scoped storage/API, acknowledgement, publication and
   single-issue resolution, with isolated PostgreSQL transaction tests.
2. Host AI runtime: bounded read context, durable turns and truthful action
   receipts. Test prompt injection and guest/internal audience separation.
3. Dashboard: center and thread, explicit controls, sign-in return path, Mission
   Control link; update notice URL only when the route is deployed and enabled.
4. Default-off host feature with explicit organization AND reservation canary.
   Preserve current guest incident flow. Outside scope keep current calendar link.
   Disable host operations independently without erasing case/history or disabling
   the certified guest reporting capability.
5. User-approved production certification: correct host and incident, reload,
   internal-note privacy, one explicit guest update, acknowledgement and one-case
   closure, duplicate clicks, revoked role, cross-tenant rejection and recurrence.
   Only use authorized test statements and closure; do not mark the existing
   hot-water incident resolved without the user's explicit instruction.

Required regressions include existing guest read tools, action proposals/history,
incident delivery/retries, Mission Control and authentication. Build/typecheck/CI
must pass. Ready, merge, deploy, migrations, flags and real communications remain
explicit approval gates. Health Center, TTLock, OTA, Stripe and unrelated Messages
behavior stay outside this design's implementation scope.
