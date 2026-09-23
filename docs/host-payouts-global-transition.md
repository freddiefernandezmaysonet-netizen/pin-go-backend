# Host Payouts global interface — draft rollout contract

No production rollout is authorized by this PR. Backend must precede dashboard.

- Retire organization canary selection for the embedded interface and sessions.
- Preserve `STRIPE_CONNECT_V2_ACCOUNT_CREATION_ENABLED` as the existing independent creation kill switch. This PR changes no variable values. If false, every organization still gets the new interface, but new account creation remains unavailable.
- Preserve Direct Charge, existing account IDs, controller settings, fees and charge readiness. Existing account ownership is checked before embedded sessions and reuse; missing/mismatched metadata fails closed, never triggers replacement.
- Retire legacy Express account creation. Historical onboarding/login endpoints remain for existing accounts only; the dashboard never selects the legacy card.
- New accounts keep the already implemented controller configuration and isolated AccountSession API version. No SDK/API upgrade or account conversion.
- Persist one provisioning claim per organization before the external creation call. Unique claim plus Stripe idempotency prevents concurrent creation. No automatic recreation when a claim is unresolved, regardless of its age.
- A saved provider account ID can be attached after a DB interruption. CLAIMED/REVIEW_REQUIRED without an ID needs an explicit future reconciliation process; this PR intentionally provides no reset or retry-create endpoint. Operators must not delete claims to retry.
- Do not apply the migration to production in this task. A later authorized rollout must apply the additive migration before backend, then dashboard. Older backend versions must not accept creation requests during cutover because they lack the durable claim guard.
- Account compatibility is not certified against live Serena or other accounts. Stripe component availability still depends on the existing account configuration. No new account is substituted if a component fails.

Validation: synthetic provider mocks, migration SQL in local in-memory PostgreSQL (PGlite), TypeScript and API bundle compilation. PGlite verifies SQL constraints and rollback, not Prisma connectivity against native PostgreSQL. Native PostgreSQL installation was unavailable due environment permissions. No real Stripe calls, AccountSessions, organizations, reservations or emails were used.
