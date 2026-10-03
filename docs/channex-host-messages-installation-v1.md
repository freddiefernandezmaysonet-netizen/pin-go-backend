# Channex host messaging: automatic application installation V1

User scope: build host conversations first; Pin AI integration comes later.
The first prerequisite is automatic Messages installation when a property is
published/prepared through Connection Center.

## Audit and implementation

Baseline: `e9df89176a564a7f68e23c8cd02a539fcde065ee`.
The API mounts Connection Center before the historical property router. It fences
the old `/distribution/enable` and `/channex/provision` mutations. Those old routes
and the frozen provisioning service are unchanged. The active operation is
`POST /api/dashboard/distribution/properties/:propertyId/channels/:provider/prepare`.

Runtime composition supplies a Messages installer to the canonical preparation
composition. After inventory and PMS linkage are persisted, installation completes
before webhook setup and initial distribution enablement complete or preparation
returns success. This applies to newly created inventory and the READY reuse path.

The installer resolves the exact organization's active property and READY canonical
Channex inventory/group. It uses the same origin/key as Connection Center. A
property-scoped PostgreSQL advisory transaction lock excludes concurrent installs.
No schema changes or migrations are needed.

It reads installed applications, reuses an existing matching installation, or sends
the documented installation payload using `application_code: channex_messages`.
A fresh GET must then verify the installation. Pagination metadata, if present,
is consumed with bounded pages and consistency checks. Inactive, ambiguous or
malformed matching installations fail closed. No uninstall or arbitrary application
installation is exposed.

Provider errors never expose raw responses or keys. Failure prevents successful
preparation and initial distribution activation while preserving remote inventory
checkpoints. Retrying preparation reuses the inventory and checks installed apps
before another POST, including after a previous uncertain outcome. There is no
background retry worker or historical bulk installation in this slice. Existing
properties are checked when preparation is invoked again.

## Documentation

- https://docs.channex.io/api-v.1-documentation/applications-api
- https://docs.channex.io/api-v.1-documentation/messages-collection

Documented endpoints: GET `/api/v1/applications/installed`; POST
`/api/v1/applications/install` with
`application_installation: { property_id, application_code: "channex_messages" }`.
The documented GET example omits `is_active`; the installer accepts that shape,
but rejects an explicit false or invalid marker. Channex documents this app as
potentially billable. No real installation was executed during development.

## Validation

- 98 tests passed, zero skipped or failed: installation, safe transport, scoped
  orchestration, Connection Center composition/runtime/routes, retained provisioning
  and repository behavior, and certified-core fingerprint.
- Strict new-module TypeScript including exactOptionalPropertyTypes and
  noUncheckedIndexedAccess passed.
- Existing Connection Center E2 TypeScript check passed without config changes.
- API ESM bundle compiled with external dependencies. This is compilation evidence,
  not server startup, live Channex delivery or production certification.
- Prisma client generated from the complete schema folder. No database changes.
- Tests use mocked provider I/O. Advisory SQL and coordination are verified with
  mocks; live multi-process PostgreSQL lock behavior was not separately exercised.

Route tests require the repository's existing CI injected-auth mode (`CI=true`,
`NODE_ENV=test`). An initial run without that environment returned 401; unchanged
baseline reproduced the same result. With the established CI configuration the
complete retained route suite passed. No auth source or auth behavior was changed.

The new CI workflow repeats type checks, regressions and compilation on publication.
No production deploy, real provider write, guest message or Pin AI execution is
included. Host conversation storage, receiving webhooks and reply UI are subsequent
work after this prerequisite.
