# Property and task cleaning checklists — block 3

Local implementation on `agent/cleaner-account-access-v1`. No push, merge, deployment, production migration, additional SMS/email or provider calls.

The host edits one property checklist from the existing property editor: add/remove/reorder items and choose which are required before finishing. Spanish and English labels are supported; at least one language is required. The cleaner sees the preferred language when supplied, otherwise the original available label. Automatic translation/Pin AI generation is not implemented in this block. The property editor deliberately loads the checklist only when expanded and requires explicit save.

Each departure cleaning owns an immutable copy of its property's template, prepared before the existing offer notification is sent. Later template edits affect new tasks only. A replacement cleaner uses the same reservation checklist, checked items and progress; actor identity/name is recorded for each changed item. This block preserves reassignment data but does not implement cancellation or backup orchestration.

Existing offers/tasks without a snapshot do not acquire obligations when the current template was edited after the first offer or work has already started. They get an empty legacy snapshot. A missing legacy checklist does not block completion. This avoids inventing historical requirements when no historical template is available.

The dashboard and existing token portal show the task checklist. It is read-only before start and after completion, and writable only by the current assigned cleaner after start within the existing completion policy. An expired access grant does not complete work or determine checklist completion. With a next check-in, the action deadline applies; without one, the already-started checklist remains editable under the same completion rule after access expiry. No checklist operation writes NFC/access state.

Required unchecked items block completion on the server in the existing completion transaction; optional items do not. The portal disables the completion button with localized guidance. Checklist item edits and completion share the departure reservation lock. Item versions and template revisions reject stale edits; the host editor retains its draft on conflict and supports explicit reload. Work timing and authorization are rechecked on each mutation.

APIs:
- Host administrator GET/PUT `/api/properties/:propertyId/cleaning-checklist`, scoped to the signed-in organization.
- Cleaner GET `/api/cleaner/cleanings/:id/checklist` and PATCH `/:itemId`, scoped to the authenticated Staff and current offer.
- Existing bearer-token portal POST `/cleaning/confirm/:token/checklist/:itemId` with the same assignment/window checks.

The additive migration `20261006230000_cleaning_checklist_v1` creates template, task snapshot, item and audit-event tables. It does not backfill obligations or change existing Staff/access records. Reservation/property deletion cascades their checklist data; actor strings preserve attribution when a Staff record is deleted.

Validation: 8 checklist checks against disposable embedded PostgreSQL (PGlite), including immutable templates, cross-organization rejection, start/required-item enforcement, stale edits, backup inheritance, audit attribution, legacy compatibility and unchanged NFC reference. The SQL harness also applied additive migrations to a synthetic legacy Staff record and confirmed preservation. Actual React runtime checks cover host save/revision conflict/reload and cleaner preferred-language progress updates. Existing work-window, mobile response, permission and SMS-language/cost regressions passed, along with targeted TypeScript, frontend lint/build, Prisma validation and backend bundle.

Before release: apply/verify migrations and concurrent row-lock/serialization behavior on an isolated native PostgreSQL staging database. PGlite validates SQL and sequential flows, not native concurrent sessions. Production end-to-end delivery remains unverified.
