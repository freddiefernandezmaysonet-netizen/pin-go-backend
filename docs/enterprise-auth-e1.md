# Pin&Go Enterprise Authentication E1 — MFA Core & Persistence Blueprint

## Scope

E1 establishes dormant primitives and a persistence **design blueprint** for a future multi-factor authentication flow. It does **not** alter `/auth/login`, `/auth/me`, signup auto-login, password reset, cookies, JWT issuance, production configuration, Prisma schema, migration history, database state, or runtime behavior.

## Rollout contract

The core recognizes three rollout modes:

- `OFF` — legacy admission is preserved.
- `SHADOW` — evaluate/observe without blocking an active user.
- `ENFORCE` — require a verified factor unless a valid trusted device satisfies policy.

No environment variable or runtime integration is added in E1. Therefore the repository remains operationally equivalent until a later integration slice explicitly wires this core into authentication.

## Persistence blueprint

`docs/design/enterprise-auth-e1-persistence.sql` documents the proposed persistence shape for:

- `AuthFactor`
- `MfaChallenge`
- `PasskeyCredential`
- `TrustedDevice`
- `RecoveryCode`
- `SecurityEvent`

The blueprint is intentionally outside `prisma/migrations/` and is not executable by Prisma migration deployment. A later separately authorized slice must translate the approved design into `prisma/schema.prisma` and a reviewed migration before any database change is possible.

OTP/recovery material is designed to be stored as a keyed HMAC rather than plaintext. Opaque bearer material is stored as SHA-256 hashes. TOTP secret storage is reserved as encrypted ciphertext and must not be populated until an application-level encryption/key-management design is approved.

## Security invariants

1. A disabled user is denied regardless of rollout mode.
2. `OFF` never requires an MFA factor.
3. `SHADOW` never blocks an active user.
4. `ENFORCE` fails closed if no verified factor exists.
5. Challenges expire, are single-consumption, and have bounded attempts.
6. Trusted-device bearer tokens must be random and only their hashes persisted.
7. Recovery codes and OTP values must never be persisted in plaintext.
8. E1 sends no email/SMS and performs no external provider calls.
9. E1 contains no executable Prisma migration and changes no database schema.

## Certification

`.github/workflows/enterprise-auth-e1-certification.yml` executes the MFA core contract tests and fails if an enterprise-auth MFA migration is present under `prisma/migrations/`.

## Explicitly deferred

- Prisma schema model declarations/client generation
- creation/application of an MFA migration
- `/auth/login` integration
- challenge persistence service
- SMS/email delivery
- TOTP enrollment/verification
- WebAuthn/passkeys
- trusted-device cookie lifecycle
- recovery-code UI
- Security Center UI
- step-up authentication
- platform-admin enforcement

These are intentionally separate slices so E1 cannot accidentally lock out existing users or mutate production persistence.
