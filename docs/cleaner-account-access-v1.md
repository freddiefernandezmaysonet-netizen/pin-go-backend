# Cleaner account and personal access — block 1

Implemented on an isolated local branch; no production migration, messages, merge or deployment.

The CLEANER role is linked to the existing StaffMember. A host administrator prepares the account by entering an unused email once. No account or temporary password is created until the cleaner activates it. The next existing confirmation SMS includes a separate activation capability in its URL; no new message family or additional SMS is sent. Old cleaning tokens have no activation rights. The capability expires after 48 hours, is hashed in storage and is consumed when the account is created. Login uses the existing authentication/MFA flow.

Account creation locks the existing Staff row and revalidates the capability, email, active organization binding and current offer. Existing email accounts are never reassigned or given another role. Existing Staff, NFC, timing commitments and assignments are preserved. Account setup is idempotent for the same email; changing it invalidates unconsumed activation capabilities.

The personal API resolves Staff from the authenticated user. Listing does not return offer tokens. Opening a current offer requires ownership, current organization, an active reservation and a non-cancelled/non-superseded work record. Access status is returned separately; COMPLETED in StaffAssignment does not become cleaning completion. Login rejects inactive or missing Staff bindings. requireAuth and the global surface guard deny host APIs to cleaners, including legacy routes without their own auth, and reject other cleaners' offer links in authenticated sessions. Existing public branding and auth endpoints retain their own rules.

Frontend companion branch provides direct login to `/my-cleanings`, separate host/cleaner guards, preferred language, a paginated initial task list and host account setup. Initial task views filter loaded results; this is not the full server-side daily/calendar contract. Work actions continue through the existing portal. Block 2 now guards its action times; see `cleaning-action-window-v1.md`. Unified acceptance, cancellation after confirmation, checklist, recovery, message reduction and Pin AI tools remain subsequent blocks.

## Validation

- Prisma schema validation and generated client passed.
- `npx tsc -p tsconfig.cleaner-account.json` passed.
- Backend server bundled successfully with esbuild and external packages.
- 19 focused account/API/permission tests passed, including concurrent activation under a serialized test transaction, expired/reassigned tokens, existing emails and scope isolation.
- 49 related auth/session, Staff language and cleaning snapshot regression tests passed.
- Frontend companion: Vite build, targeted strict TypeScript and ESLint passed; 21 UI/auth/language tests passed, including rendered role isolation and cleaner login without host property queries.

Tests use synthetic data and local HTTP/DOM, not production. The original tests use mocks; the follow-up SQL validation below uses an embedded PostgreSQL engine. Native PostgreSQL migration/deployment tooling, multi-connection concurrency and real MFA/login still need isolated integration verification before merge or deployment. No provider delivery or SMS segment cost was certified. The one-time activation query adds URL length to the existing SMS, so no additional message does not necessarily mean identical segment cost.

### Follow-up isolated SQL validation — October 6, 2026

The exact additive migration was applied to a baseline generated from the parent commit's Prisma schema in disposable PGlite 0.5.8. All pre-existing Staff fields, preferred language and synthetic NFC reference were preserved. This runs PostgreSQL's embedded engine, not a native PostgreSQL server or the historical migration chain.

The real Prisma client and account service passed 5 database checks (one parent test plus four subtests): idempotent preparation and organization isolation; old/expired capability rejection; restricted account creation, consumption of all capabilities and preservation of work/access/language/NFC; SQL unique-link and foreign-key enforcement. PGlite's socket bridge required reconnecting after deliberate SQL constraint failures. No production code was changed by this follow-up.

The reusable test is `src/services/cleaner-account.database.test.ts`. It opts in only through `CLEANER_ACCOUNT_TEST_DATABASE_URL`, checks a loopback hostname and the dedicated database name `cleaner_account_test`, and does not take a production URL from `DATABASE_URL`. Without the opt-in it skips. Run against an already provisioned, migrated disposable database with a synthetic JWT_SECRET:

```sh
CLEANER_ACCOUNT_TEST_DATABASE_URL='postgresql://test:test@127.0.0.1:5432/cleaner_account_test' node --import tsx --test src/services/cleaner-account.database.test.ts
```

Native multi-connection activation races remain pending. PGlite's single-connection engine does not certify row-lock behavior between independent PostgreSQL sessions.

### Follow-up cleaner login and MFA validation

Five additional SQL/HTTP checks passed using the real login, MFA, personal API and global authorization routes against the disposable engine. Existing auth E2/E4 SQL migrations provisioned the externally managed auth tables. The Resend SDK transport was replaced in the test with an in-memory capture; any external fetch was forbidden. No real email or SMS was sent.

The checks cover invalid password without a challenge/session, a valid MFA challenge and one-use verification, issuance of a CLEANER session, access to the personal profile and denial of a legacy host endpoint. They also cover Staff disabling and unlinking between password and MFA. The audit found MFA resolution previously checked DashboardUser activity but not its current Staff binding. `mfa-login.routes.ts` now revalidates active Staff and the same organization before verification or resend; a disabled/unlinked cleaner cannot receive a new session or trusted device through an outstanding challenge. Existing active-cleaner sessions are denied personal access by the global guard after disabling.

The reusable opt-in test is `src/auth/cleaner-login.database.test.ts`, with the same isolated loopback database guard. Native PostgreSQL verification and actual provider delivery remain pending; the application login/MFA path has now been exercised locally with synthetic delivery.

Local test commands (provide a synthetic JWT_SECRET of at least 32 characters):

```sh
node --import tsx --test src/services/cleaner-account.service.test.ts src/routes/cleaner-account.routes.test.ts
npx tsc -p tsconfig.cleaner-account.json
```

The new migration is additive. Deploy backend/migration before the companion frontend only after separately authorized database checks and release review. Branch publication is pending; no push was performed to avoid triggering preview or production deployments.
