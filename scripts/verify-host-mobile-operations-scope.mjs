import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASE = '69434d924208153a444ef5716e7c414380dff899';
export const MIGRATION = 'prisma/migrations/20261016210000_host_mobile_push_registry/migration.sql';
export const ALLOWED = [
  "docs/host-mobile-push-delivery.md",
  "src/services/host-mobile-push-token.ts",
  "src/services/host-mobile-push-token.test.ts",
  "src/services/host-mobile-push-provider.ts",
  "src/services/host-mobile-push-provider.test.ts",
  "src/services/host-mobile-push-delivery.repository.ts",
  "src/services/host-mobile-push-delivery.service.ts",
  "src/services/host-mobile-push-delivery.service.test.ts",
  "src/pin-ai/host/host-push-delivery.database.test.ts",
  "src/workers/host-mobile-push.worker.ts",
  "tsconfig.host-mobile-push.json",

  "src/services/sales-voice-safety-controller.service.test.ts",
  ".github/workflows/ota-initial-distribution-enablement.yml",
  ".github/workflows/sales-voice-live-sip-mount-v1.yml",
  ".github/workflows/channex-host-inbox-v1.yml",
  ".github/workflows/ota-airbnb-listing-discovery.yml",
  ".github/workflows/pin-ai-host-incidents-v1.yml",
  ".github/workflows/sales-voice-crm-foundation-v1.yml",
  ".github/workflows/sales-voice-main-integration-certification.yml",
  ".github/workflows/sales-voice-recovery-lease-certification.yml",
  "docs/host-mobile-ci-integration.md",
  "docs/host-mobile-incident-actions.md",
  "docs/host-mobile-notification-policy.md",
  "docs/host-mobile-push-registry.md",
  "prisma/migrations/20261016210000_host_mobile_push_registry/migration.sql",
  "prisma/schema.prisma",
  "scripts/verify-host-mobile-operations-scope.mjs",
  "scripts/verify-host-mobile-operations-scope.test.mjs",
  "src/channex-messaging/host-inbox.postgres.test.ts",
  "src/channex-messaging/mobile-reply-authorization.test.mjs",
  "src/channex-messaging/mobile-reply-authorization.ts",
  "src/channex-messaging/mobile-reply-http.test.mjs",
  "src/channex-messaging/mobile-reply-receipt.test.mjs",
  "src/channex-messaging/mobile-reply-receipt.ts",
  "src/pin-ai/host/host-incident-mobile.test.ts",
  "src/pin-ai/host/host-incident.database.test.ts",
  "src/pin-ai/host/host-incident.service.ts",
  "src/pin-ai/host/host-push-registry-http.test.ts",
  "src/pin-ai/host/host-push-registry.database.test.ts",
  "src/pin-ai/host/host-push-registry.test.ts",
  "src/routes/dashboard.channex-host-inbox.route.ts",
  "src/routes/dashboard.pin-ai-host-incidents.routes.ts",
  "src/routes/host-mobile-notifications.routes.ts",
  "src/services/host-mobile-notification.policy.test.ts",
  "src/services/host-mobile-notification.policy.ts",
  "src/services/host-mobile-notification.registry.ts"
];
export const RELATIONS = "  mobilePushDevices HostMobilePushDevice[]\n  mobilePushPreference HostMobilePushPreference?\n";
export const MODELS = "\nmodel HostMobilePushDevice {\n  id String @id\n  userId String\n  organizationId String\n  sessionId String\n  tokenHash String @unique\n  tokenCiphertext String\n  bindingVersion Int @default(1)\n  platform String\n  projectId String\n  revokedAt DateTime?\n  expiresAt DateTime\n  updatedAt DateTime @updatedAt\n  createdAt DateTime @default(now())\n  user DashboardUser @relation(fields: [userId], references: [id], onDelete: Cascade)\n  @@index([organizationId, userId, sessionId])\n}\n\nmodel HostMobilePushPreference {\n  userId String @id\n  organizationId String\n  enabled Boolean @default(false)\n  kinds String[]\n  timezone String @default(\"UTC\")\n  quietStartHour Int?\n  quietEndHour Int?\n  allowCritical Boolean @default(false)\n  revision Int @default(0)\n  updatedAt DateTime @updatedAt\n  user DashboardUser @relation(fields: [userId], references: [id], onDelete: Cascade)\n}\n\n// Metadata-only dispatch ledger. Live authority always comes from current source,\n// device, user, property and session rows; these scalar references confer no access.\nmodel HostMobilePushDelivery {\n  id String @id\n  sourceId String\n  sourceEpoch Int\n  organizationId String\n  propertyId String\n  userId String\n  sessionId String\n  deviceId String\n  deviceUpdatedAt DateTime\n  deviceBindingVersion Int\n  eventId String\n  kind String\n  occurredAt DateTime\n  expiresAt DateTime\n  state String @default(\"QUEUED\")\n  availableAt DateTime @default(now())\n  leaseOwner String?\n  leaseUntil DateTime?\n  leaseEpoch Int @default(0)\n  attempts Int @default(0)\n  ticketId String?\n  acceptedAt DateTime?\n  receiptDeadline DateTime?\n  outcomeCode String?\n  createdAt DateTime @default(now())\n  updatedAt DateTime @updatedAt\n\n  @@unique([sourceId, sourceEpoch, deviceId, userId], map: \"HostMobilePushDelivery_source_device_user_key\")\n  @@index([state, availableAt])\n  @@index([leaseUntil])\n  @@index([organizationId, userId])\n}\n";

export function verifyHostScope({ event, paths, before, after, base = BASE }) {
  const repo = 'freddiefernandezmaysonet-netizen/pin-go-backend';
  assert.equal(event.number, 472, 'Only Host operations PR472');
  assert.equal(event.pull_request?.head?.repo?.full_name, repo, 'No fork exemption');
  assert.equal(event.pull_request?.base?.repo?.full_name, repo);
  assert.equal(event.pull_request?.head?.ref, 'agent/host-mobile-operations-20261016');
  assert.equal(event.pull_request?.base?.ref, 'main');
  assert.equal(event.pull_request?.base?.sha, base, 'Re-review scope after base changes');
  assert.deepEqual([...paths].sort(), [...ALLOWED].sort(), 'Exact Host operation files required');
  assert.equal(after.split(RELATIONS).length, 2, 'Exactly one Host user relation block');
  assert.ok(after.endsWith(MODELS), 'Exact additive Host models required');
  assert.equal(after.slice(0, -MODELS.length).replace(RELATIONS, ''), before,
    'Every pre-existing schema definition, including sales and OTA, must be unchanged');
}

export const EXPIRY_TEST = 'src/services/sales-voice-safety-controller.service.test.ts';
const OLD_EXPIRY_FIXTURE = 'await seed(1);const now=Date.now(),window={startsAtMs:now-20000,endsAtMs:now-1000};';
const NEW_EXPIRY_FIXTURE = 'await seed(10);const now=Date.now(),window={startsAtMs:now-20000,endsAtMs:now-1000};';
export function verifyExpiryFixture(before, after) {
  assert.equal(before.split(OLD_EXPIRY_FIXTURE).length,2,'Exactly one original expiry fixture');
  assert.equal(after,before.replace(OLD_EXPIRY_FIXTURE,NEW_EXPIRY_FIXTURE),
    'Only position the test call safely inside the expired window; preserve all assertions');
}

export function inspectCandidate(git, event, runtimeSchema) {
  const candidate = event.pull_request.head.sha;
  assert.match(candidate, /^[0-9a-f]{40}$/);
  assert.equal(git('merge-base', BASE, candidate).trim(), BASE, 'Pinned base must be a candidate ancestor');
  assert.equal(git('merge-base', candidate, 'HEAD').trim(), candidate, 'Checkout must include candidate');
  const candidateSchema = git('show', candidate + ':prisma/schema.prisma');
  assert.equal(runtimeSchema, candidateSchema, 'Merged checkout schema requires separate review if different');
  const paths = git('diff', '--name-only', BASE, candidate).trim().split('\n');
  verifyHostScope({event, paths, before:git('show', BASE + ':prisma/schema.prisma'), after:candidateSchema});
  verifyExpiryFixture(git('show',BASE+':'+EXPIRY_TEST),git('show',candidate+':'+EXPIRY_TEST));
  git('diff', '--check', BASE, candidate);
  git('diff', '--check', BASE, 'HEAD');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request');
  assert.equal(process.env.GITHUB_REPOSITORY, 'freddiefernandezmaysonet-netizen/pin-go-backend');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  inspectCandidate(git, event, readFileSync('prisma/schema.prisma','utf8'));
  console.log('PASS exact PR472 candidate scope; existing sales/OTA schema preserved. Continue every runtime suite.');
}
