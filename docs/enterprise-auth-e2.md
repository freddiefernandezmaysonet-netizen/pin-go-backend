# Pin&Go Enterprise Authentication E2 — Email + SMS OTP

E2 introduces persistence and pure domain policy for EMAIL/SMS OTP factors without integrating MFA into login.

## Included

- AuthFactor, MfaChallenge and SecurityEvent persistence migration.
- EMAIL/SMS destination normalization and masking.
- Six-digit cryptographic OTPs.
- OTP HMAC bound to challenge identity.
- Five-minute challenge TTL.
- Five-attempt maximum.
- Sixty-second resend cooldown.
- MOCK-only delivery adapter.
- Dedicated CI certification against ephemeral PostgreSQL.

## Safety boundary

- `/auth/login`, `/auth/me`, signup auto-login and JWT/cookie issuance are unchanged.
- No environment variable enables MFA.
- No SMS or email provider is called by E2.
- The migration is committed for review and CI only; it is not applied to production by this change.
- `PendingSignup.phone` is not an MFA identity source.
- TOTP, passkeys, trusted devices, recovery codes and step-up authentication remain deferred.

A later separately authorized runtime slice must enroll/verify factors, connect delivery providers, and integrate challenges with login.
