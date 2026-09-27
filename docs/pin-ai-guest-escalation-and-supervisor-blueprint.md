# Pin AI — Guest Escalation and Future Host Supervisor

Design and read-only audit, 2026-09-27. Not an implementation or deployment.

## Decisions agreed with Freddie

Finish the guest agent first. Build Supervisor and Host Approvals as a separate
layer afterward. The host will configure permitted actions, property scope,
spending limits, approval requirements, authorized contacts, escalation timing
and autonomy level in Dashboard. Backend authorization, not model judgment,
enforces identity, property membership and permissions. A supervisor cannot
expand its own authority. Approvals bind to an exact action, scope, amount,
version and expiry, with audit and a suspension mechanism.

The guest agent collects requests and communicates progress. The future
supervisor coordinates exceptions and host decisions. Existing canonical
engines execute authorized work and provide evidence. Both agents share case
state; neither invents delivery, approval or completion.

## Audited state

GitHub main: e17b394996bca67464ba42f6814f199f8160e305. It includes the separate
Health Center work; that implementation is excluded from this task.
At audit time Railway backend deployment 63bcf380-2c18-477b-828c-408eefaee498
was BUILDING on that SHA. Previous Pin AI NFC evidence production deployment
on 1af075c was verified SUCCESS earlier in this session.

openai-agents-runtime-transport.ts intercepts escalate_to_host and returns
shadow=true, executed=false and SHADOW_MODE_ESCALATION_NOT_EXECUTED, bypassing
the runtime executor. Agent instructions explicitly describe shadow escalation.
Changing wording alone would not implement escalation.

upsertOperationalIssue already provides transactional persistence, a stable
operational key, transition validation and history. dashboard.properties.route.ts
projects HOST incidents in actionable states into Mission Control. These are
reuse candidates, not proof of outbound delivery.

## Next guest-agent capability: durable incident registration

Proposed initial scope: record a guest-reported service incident, deduplicate
retries/repeated turns for the same open case, make it available through the
existing host incident projection, and return a safe receipt. No automatic
maintenance purchase, reservation modification, refund, device command or
host approval is included.

The hot-water example is an unverified guest report, not a confirmed hardware
diagnosis. Record the reported scope (all taps) and only troubleshooting the
guest actually confirmed. Do not infer they completed suggested steps.

The server derives organization/property/reservation/guest from authenticated
context. Tool input must not choose a recipient, tenant, authorization level or
arbitrary operational key. Define bounded categories, summary lengths and
server-owned priority rules. Escape guest text in every display or message.
Define concurrent deduplication and a separate policy for recurrence after a
resolved case, rather than silently reopening or suppressing it forever.

Return separate facts: incidentRecorded, incident reference, hostAttentionRecorded,
notification state, and resolution state. Registration alone permits saying
the issue was recorded for review, never that the host received a notification.
Do not call an incident resolved merely because it was recorded or delivered.

## Notification integration boundary

Audit the existing notification and recipient-resolution flow before selecting
an outbound adapter. The original Messages-engine exclusion still applies;
request scoped authorization before modifying that engine or sending a live
notification. This blueprint sends nothing and does not certify notification.
An initial registration-only release must disclose that limit explicitly.

## Required implementation validation

- Cross-tenant and cross-reservation rejection; guest cannot impersonate host.
- Retry and concurrent-call deduplication; unrelated incidents remain distinct.
- Safe handling of missing reservation, invalid input and database failure.
- Recorded versus queued/delivered versus resolved evidence stays distinct.
- Default-off canary and unchanged behavior outside authorized scope.
- Existing Pin AI read tools, proposal/payment boundaries and history regressions.
- PostgreSQL transaction test and host projection verification before certification.
- Real notification and host approval are separate certification gates.

No runtime code, production variables or provider configuration was changed by
this design. Ready, merge, deployment and live communications require explicit
authorization. Supervisor configuration UI and approval execution are deferred.
