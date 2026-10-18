import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// One reviewed additive inbox candidate. This does not change a commercial/OTA
// allowlist or grant an exemption to another branch, fork, base or migration.
export const BASE='10af8a39ff111fc0e3c484f512c5c876dbea5815';
export const MIGRATION='prisma/migrations/20261018163000_host_notification_inbox/migration.sql';
export const ALLOWED=[
  ".github/workflows/ota-airbnb-listing-discovery.yml",
  ".github/workflows/ota-initial-distribution-enablement.yml",
  ".github/workflows/pin-ai-host-incidents-v1.yml",
  ".github/workflows/sales-voice-crm-foundation-v1.yml",
  ".github/workflows/sales-voice-live-sip-mount-v1.yml",
  ".github/workflows/sales-voice-main-integration-certification.yml",
  ".github/workflows/sales-voice-recovery-lease-certification.yml",
  "docs/host-notification-inbox.md",
  "prisma/migrations/20261018163000_host_notification_inbox/migration.sql",
  "prisma/schema.prisma",
  "scripts/verify-host-notification-inbox-scope.mjs",
  "scripts/verify-host-notification-inbox-scope.test.mjs",
  "src/pin-ai/host/host-notification-inbox.database.test.ts",
  "src/pin-ai/host/host-push-registry-http.test.ts",
  "src/routes/host-mobile-notifications.routes.ts",
  "src/services/host-mobile-notification-inbox.ts"
];
export const INDEX='  @@index([organizationId, userId, occurredAt(sort: Desc)], map: "HostMobilePushDelivery_inbox_idx")\n';
export const INDEX_ANCHOR='  @@unique([sourceId, sourceEpoch, deviceId, userId], map: "HostMobilePushDelivery_source_device_user_key")\n';
export const MODEL=`// Inbox acknowledgement is independent of guest-message reads and issue resolution.
model HostMobileNotificationRead {
  organizationId String
  userId String
  propertyId String
  eventId String
  readAt DateTime @default(now())

  @@id([organizationId, userId, propertyId, eventId], map: "HostMobileNotificationRead_scope_key")
  @@index([readAt])
}
`;
export const SQL=`CREATE TABLE "HostMobileNotificationRead" (
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostMobileNotificationRead_scope_key" PRIMARY KEY ("organizationId", "userId", "propertyId", "eventId")
);
CREATE INDEX "HostMobileNotificationRead_readAt_idx" ON "HostMobileNotificationRead"("readAt");
CREATE INDEX "HostMobilePushDelivery_inbox_idx" ON "HostMobilePushDelivery"("organizationId", "userId", "occurredAt" DESC);
`;
export function verifyInboxScope({event,paths,before,after,migration}) {
  const repo='freddiefernandezmaysonet-netizen/pin-go-backend';
  assert.equal(event.number,475,'Only the reviewed inbox PR');
  assert.equal(event.pull_request?.head?.repo?.full_name,repo,'No fork exemption');
  assert.equal(event.pull_request?.base?.repo?.full_name,repo);
  assert.equal(event.pull_request?.head?.ref,'agent/host-notification-inbox-20261018');
  assert.equal(event.pull_request?.base?.ref,'main');
  assert.equal(event.pull_request?.base?.sha,BASE,'Base changes require a fresh scope review');
  assert.deepEqual([...paths].sort(),[...ALLOWED].sort(),'Exact inbox and CI files only');
  assert.equal(before.includes(MODEL),false,'Inbox must be additive');
  assert.equal(before.includes(INDEX),false);
  assert.equal(after.split(MODEL).length,2,'Exactly the reviewed read model');
  assert.equal(after.split(INDEX).length,2,'Exactly the reviewed ledger index');
  assert.equal(before.split(INDEX_ANCHOR).length,2,'Exactly one original ledger key');
  assert.ok(after.includes(INDEX_ANCHOR+INDEX),'The index belongs only to the existing dispatch ledger');
  assert.ok(after.trimEnd().endsWith(MODEL.trimEnd()),'Read model must be appended');
  const restored=after.replace(MODEL,'').replace(INDEX,'');
  assert.equal(restored.trimEnd(),before.trimEnd(),'Every pre-existing schema definition must remain unchanged');
  assert.equal(migration.trimEnd(),SQL.trimEnd(),'Only the reviewed additive inbox SQL');
}
export function inspectCandidate(git,event,runtimeSchema) {
  const candidate=event.pull_request?.head?.sha;
  assert.match(candidate??'',/^[0-9a-f]{40}$/);
  assert.equal(git('merge-base',BASE,candidate).trim(),BASE,'Pinned base must be an ancestor');
  // A synthetic PR merge is allowed only when it has the exact candidate tree.
  git('diff','--exit-code',candidate,'HEAD','--','.');
  const schema=git('show',candidate+':prisma/schema.prisma');
  assert.equal(runtimeSchema,schema,'Validate the schema that the tests actually use');
  verifyInboxScope({event,paths:git('diff','--name-only',BASE,candidate).trim().split('\n'),
    before:git('show',BASE+':prisma/schema.prisma'),after:schema,migration:git('show',candidate+':'+MIGRATION)});
  // Exact allowlisting already excludes all other runtime paths. These explicit
  // freezes also make the retained commercial/OTA boundaries visible in CI.
  git('diff','--exit-code',BASE,candidate,'--','src/distribution','src/channex-messaging','src/pms',
    'src/workers','src/server.ts',':(glob)src/services/sales-voice-*',':(glob)tests/sales-voice-*');
  git('diff','--check',BASE,candidate);
  git('diff','--check',BASE,'HEAD');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_EVENT_NAME,'pull_request');
  assert.equal(process.env.GITHUB_REPOSITORY,'freddiefernandezmaysonet-netizen/pin-go-backend');
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'});
  inspectCandidate(git,event,readFileSync('prisma/schema.prisma','utf8'));
  console.log('PASS exact PR475 inbox addition; sales/OTA runtime and prior schema unchanged. Continue every certification suite.');
}
