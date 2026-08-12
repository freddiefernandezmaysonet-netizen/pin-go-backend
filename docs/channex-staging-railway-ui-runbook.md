# Pin&Go Connect — Railway Staging UI Runbook

## Purpose

Create the isolated Railway staging environment required to execute issue #25 and certify draft PR #24 without touching production.

This runbook does not authorize merge or production deployment.

## Source

Repository:

`freddiefernandezmaysonet-netizen/pin-go-backend`

Branch:

`recovery/distribution-engine-v2-channex-lifecycle`

Use the exact current head SHA of PR #24 for both API and worker.

## 1. Create the staging environment

1. Open the existing Railway project.
2. Open the environment selector in the top navigation.
3. Select `+ New Environment`.
4. Choose `Empty Environment`.
5. Name it `staging-channex-certification`.
6. Do not duplicate production; the environment must begin empty.
7. Review and apply the staged environment creation.

## 2. Add PostgreSQL staging

1. Enter the new empty environment.
2. Select `+ New` on the Project Canvas or use `Ctrl + K`.
3. Choose `Database` → `PostgreSQL`.
4. Name the service `Postgres-Staging` if Railway permits renaming during creation.
5. Confirm the database deploys successfully.
6. Do not import production data.
7. Retain only synthetic organizations, properties, mappings and reservations.

Railway exposes `DATABASE_URL` on the PostgreSQL service. API and worker must reference that same value through a Railway service-variable reference rather than copying the raw URL manually.

Reference form:

```text
${{Postgres-Staging.DATABASE_URL}}
```

If the actual database service name differs, use that exact service name in the reference.

## 3. Create the API staging service

1. Select `+ New` → `GitHub Repo`.
2. Connect `freddiefernandezmaysonet-netizen/pin-go-backend`.
3. Set the source branch to `recovery/distribution-engine-v2-channex-lifecycle`.
4. Name the service `pin-go-api-staging`.
5. Open the service `Settings` tab.
6. Under Config as Code, set the custom config path to:

```text
/railway.api.json
```

7. Confirm the deployment settings show:

```text
Start command: npm start
Health check: /ready
Restart policy: ON_FAILURE
Maximum retries: 10
```

8. Configure exactly one replica for initial certification.
9. Generate a Railway public HTTPS domain for the API.
10. Record the domain without adding `/webhooks/channex` yet.

## 4. Configure API variables

Open the API service `Variables` tab. Use `New Variable` or the RAW Editor.

Required staging-only variables include:

```text
NODE_ENV=staging
DATABASE_URL=${{Postgres-Staging.DATABASE_URL}}
CHANNEX_API_BASE_URL=https://staging.channex.io
CHANNEX_API_KEY=<staging key>
PMS_CREDENTIALS_SECRET=<staging encryption secret>
JWT_SECRET=<staging jwt secret>
FRONTEND_ORIGIN=<staging frontend origin>
PUBLIC_API_BASE_URL=https://<api-staging-domain>
API_BASE_URL=https://<api-staging-domain>
```

Also provide any existing backend runtime variables required for imports and startup, using staging credentials only.

Do not reuse production values for:

- database;
- Channex API key;
- JWT secret;
- PMS credential-encryption secret;
- Stripe, Twilio, Resend or TTLock credentials;
- frontend origin.

Review and deploy the staged variable changes.

## 5. Verify the API

After deployment:

```text
GET https://<api-staging-domain>/health
```

Expected:

```json
{ "ok": true }
```

Then:

```text
GET https://<api-staging-domain>/ready
```

Expected:

```json
{ "ok": true }
```

Do not continue if `/ready` fails.

## 6. Create the recovery-worker service

1. Select `+ New` → `GitHub Repo`.
2. Connect the same backend repository.
3. Select the same branch as the API.
4. Name the service `pin-go-connect-recovery`.
5. Open `Settings`.
6. Set Config as Code path to:

```text
/railway.pms-webhook-recovery.json
```

7. Confirm the deployment settings show:

```text
Start command: npm run worker:pms-webhook-recovery
Health check: none
Restart policy: ON_FAILURE
Maximum retries: 10
```

8. Configure exactly one replica.
9. Do not generate a public domain.
10. Do not mount this worker inside another worker or the API service.

## 7. Configure worker variables

The worker must reference the same PostgreSQL service and use the same staging Channex and credential-encryption context as the API:

```text
NODE_ENV=staging
DATABASE_URL=${{Postgres-Staging.DATABASE_URL}}
CHANNEX_API_BASE_URL=https://staging.channex.io
CHANNEX_API_KEY=<same staging Channex key used by API>
PMS_CREDENTIALS_SECRET=<same staging encryption secret used by API>
PMS_WEBHOOK_RECOVERY_POLL_MS=5000
PMS_WEBHOOK_RECOVERY_BATCH_SIZE=20
PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS=8
PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS=0
PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS=30000
PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS=600000
```

Review and deploy the staged changes.

## 8. Verify commit and database compatibility

Run the following one-off command in the API service shell:

```bash
PIN_GO_RUNTIME_ROLE=API npm run staging:runtime:fingerprint
```

Run the following one-off command in the worker service shell:

```bash
PIN_GO_RUNTIME_ROLE=RECOVERY_WORKER npm run staging:runtime:fingerprint
```

The outputs must have:

- identical `source.commitSha`;
- identical `databaseFingerprint`;
- identical `compatibilityKey`;
- identical project and environment names;
- different roles;
- different service identities.

Do not retain raw environment variables or `DATABASE_URL`.

## 9. Prepare staging Pin&Go data

Before webhook registration:

1. Create a synthetic staging organization.
2. Create a synthetic host account.
3. Create one staging property.
4. Provision the property in Channex staging.
5. Confirm one active Channex connection.
6. Confirm every room type uses that same connection.
7. Confirm every mapping has `metadata.channexPropertyId`.
8. Confirm every mapping has a Channex room type ID in `externalListingId`.
9. Confirm no second active connection maps the property.

## 10. Register the webhook

Use a trusted Railway shell attached to the API staging service.

Set:

```text
PIN_GO_PROPERTY_ID=<staging Pin&Go property ID>
CHANNEX_API_KEY=<staging Channex key>
CHANNEX_API_BASE_URL=https://staging.channex.io
CHANNEX_WEBHOOK_CALLBACK_URL=https://<api-staging-domain>/webhooks/channex
CHANNEX_STAGING_WEBHOOK_CONFIRMATION=CONFIGURE_CHANNEX_STAGING_WEBHOOK
```

Run:

```bash
npm run channex:staging:configure-booking-webhook
```

Retain only the sanitized result.

## 11. Run readiness

```bash
npm run channex:staging:check-readiness
```

Required result:

```text
ready: true
exit code: 0
```

Only then begin the lifecycle protocol in:

`docs/channex-staging-booking-lifecycle-certification.md`

## 12. Required deployment evidence

Retain sanitized evidence of:

- environment name;
- database service name;
- API service name and Config File path;
- worker service name and Config File path;
- branch and commit SHA;
- API and worker replica counts;
- API `/health` and `/ready` results;
- API and worker runtime fingerprints;
- non-secret variable names;
- webhook registration result;
- readiness report.

Do not retain:

- API keys;
- JWT secrets;
- PMS encryption secrets;
- `DATABASE_URL`;
- guest PII;
- raw webhook payloads;
- payment details.

## Official Railway references

- Environments: https://docs.railway.com/environments
- Services: https://docs.railway.com/services
- PostgreSQL: https://docs.railway.com/databases/postgresql
- Variables and RAW Editor: https://docs.railway.com/variables
- Config as Code: https://docs.railway.com/config-as-code
- Variable references: https://docs.railway.com/integrations/api/manage-variables
