# Host rolling session policy

Prepared 2026-10-20; not deployed. Requires coordinated backend deployment and a separately authorized Host build.

## Behavior

- Newly authenticated Host web sessions: 24 hours of inactivity.
- Newly authenticated renewal-capable Host native sessions: 30 days of inactivity. Existing native builds retain legacy behavior until upgraded and signed in again.
- Native client advertises renewal support at login/MFA verification. Policy is persisted in AuthSession and signed into the credential; later headers cannot upgrade it.
- Human activity rolls the database lease. Native foreground/touch events and existing web activity events renew credentials. Ordinary polling and push delivery do not extend the lease.
- Rolling policies enforce database validation even while legacy session enforcement is SHADOW. Explicit logout, revocation, account/organization mismatch, disabled users and tokenVersion changes remain terminal.
- Existing sessions are migrated as LEGACY and are never revived. Cleaner and platform-administrator policies are unchanged. Guest reservation access windows are unchanged.
- Existing MFA/trusted-device rules remain; no new sensitive-action step-up workflow is claimed in this change.

## Release order and verification

1. Review and deploy backend PR 485 with the additive migration and regenerated Prisma client.
2. Obtain Freddie's permission before the next EAS Host build. Install it, sign in again, verify resume and voluntary sign-out on a real device.
3. Verify web authentication/renewal against the deployed backend. Current Dashboard AuthProvider already emits human activity events and accepts the renewed HTTP-only cookie; no web source change is required.
4. Confirm on-device permission, registration and actual push receipt independently. Continuous dispatcher activation and the existing 30-day push-device enrollment TTL are still pending. This change does not claim indefinite push enrollment or successful physical delivery.

## Evidence

32 focused backend tests pass, covering rolling boundaries, renewal across months, JWT lifetimes/claims, real login/MFA/activity HTTP routes, web cookie renewal, rejection after revocation, and existing push authorization separation. 24 focused mobile tests pass across renewal races, session recovery and notification setup. Backend auth TypeScript and mobile TypeScript pass. Migration is checked against a pre-existing synthetic AuthSession row; existing rows remain LEGACY. Physical device validation remains pending.
