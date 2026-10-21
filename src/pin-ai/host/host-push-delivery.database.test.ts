import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {createHostPushRegistry} from '../../services/host-mobile-notification.registry.js';
import {createHostPushDeliveryRepository, maintainHostPushRecords} from '../../services/host-mobile-push-delivery.repository.js';
import {runHostPushDeliveryCycle} from '../../services/host-mobile-push-delivery.service.js';
import {createMobileMessageReads} from '../../channex-messaging/mobile-message-read.js';
import {HOST_PUSH_PROJECT} from '../../services/host-mobile-push-token.js';

const enabled = process.env.PIN_AI_HOST_INCIDENT_DB_TEST === 'true';
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
if (enabled && (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/pin_ai_host_incident_test'))
  throw Error('Isolated local host database required');

test('PostgreSQL durable push delivery, concurrency, current authorization and crash recovery', {skip: !enabled}, async t => {
  const db = new PrismaClient();
  // Foundation CI starts from schema.prisma only; AuthSession is an external
  // multi-file model. Use its exact committed CREATE statement in this disposable
  // database, never a hand-written approximation or a persistent migration.
  const canonical = readFileSync('prisma/migrations/20260916133000_add_enterprise_auth_e4_trusted_session/migration.sql', 'utf8');
  const create = canonical.match(/CREATE TABLE "AuthSession" \([\s\S]*?\n\);/)?.[0];
  assert.ok(create);
  await db.$executeRawUnsafe(create.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
  const sessionPolicySql = readFileSync('prisma/migrations/20261020210000_host_session_policy/migration.sql', 'utf8');
  await db.$executeRawUnsafe(sessionPolicySql.replace('ADD COLUMN ', 'ADD COLUMN IF NOT EXISTS '));
  const inboundSql = readFileSync('prisma/migrations/20261003181000_channex_pin_ai_inbound/migration.sql', 'utf8');
  for (const statement of inboundSql.split(';').filter(part => part.trim()))
    await db.$executeRawUnsafe(statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
      .replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ').replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS '));
  const org = await db.organization.create({data: {name: 'Synthetic push delivery'}});
  const other = await db.organization.create({data: {name: 'Synthetic unrelated tenant'}});
  const user = await db.dashboardUser.create({data: {organizationId: org.id, email: `${randomUUID()}@example.invalid`, passwordHash: 'synthetic', role: 'ORG_ADMIN'}});
  const property = await db.property.create({data: {organizationId: org.id, name: 'Synthetic property'}});
  const now = new Date();
  const session = await db.authSession.create({data: {userId: user.id, organizationId: org.id, tokenVersion: 0,
    authenticatedAt: new Date(now.getTime() - 60_000), lastActivityAt: new Date(now.getTime() - 30_000), absoluteExpiresAt: new Date(now.getTime() + 3600000)}});
  const env = {HOST_MOBILE_PUSH_TOKEN_KEY_ID: 'test', HOST_MOBILE_PUSH_TOKEN_KEYS: JSON.stringify({test: 'ab'.repeat(32)}),
    HOST_MOBILE_PUSH_DELIVERY_ENABLED: 'true', HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS: JSON.stringify([property.id]),
    HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE: new Date(now.getTime() - 60_000).toISOString()};
  const registry = createHostPushRegistry(db, env), repository = createHostPushDeliveryRepository(db);
  const actor = {id: user.id, orgId: org.id, sessionId: session.id};
  const token = `ExpoPushToken[synthetic_${randomUUID().replaceAll('-', '')}]`;
  await registry.register(actor, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
  const device = await db.hostMobilePushDevice.findFirstOrThrow({where: {userId: user.id}});
  await registry.savePreference(actor, {enabled: true, kinds: ['GUEST_INCIDENT', 'CLEANING_EXCEPTION', 'ACCESS_EXCEPTION'], timezone: 'UTC', quietHours: null, expectedRevision: 0});
  async function issue(engine = 'PIN_AI_GUEST_INCIDENT', target: 'RESERVATION' | 'CLEANING' | 'ACCESS' | 'MESSAGING' = 'RESERVATION') {
    return db.operationalIssue.create({data: {operationalKey: randomUUID(), issueCode: 'SYNTHETIC', title: 'PRIVATE TITLE', issue: 'PRIVATE BODY',
      engine, severity: 'WARNING', workflowState: 'ACTION_REQUIRED', visibility: 'HOST', responsibleActor: 'HOST', actionRequired: true,
      canAutoResolve: false, organizationId: org.id, propertyId: property.id, sourceType: 'WORKER', actionTarget: target,
      lastSignalAt: new Date(Date.now() - 1000)}});
  }
  async function clear() {
    await db.hostMobilePushDelivery.deleteMany({where: {organizationId: org.id}});
    await db.operationalIssue.deleteMany({where: {organizationId: org.id}});
  }
  const enqueue = () => repository.materialize([property.id], new Date(env.HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE));
  try {
    await t.test('concurrent producers and claimants yield one event/device attempt; metadata stays private', async () => {
      await issue(); await Promise.all(Array.from({length: 5}, enqueue));
      assert.equal(await db.hostMobilePushDelivery.count({where: {organizationId: org.id}}), 1);
      const claims = await Promise.all(Array.from({length: 8}, (_, n) => repository.claim('SEND', `owner-${n}`)));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.doesNotMatch(JSON.stringify(claims), /PRIVATE TITLE|PRIVATE BODY|ExpoPushToken|tokenCiphertext/);
      await clear();
    });
    await t.test('dispatch denies changed role, tenant, tokenVersion, session revocation, device expiry, property, source and preferences', async () => {
      const source = await issue(); await enqueue();
      const row = (await repository.claim('SEND', 'guard-owner'))!;
      assert.ok(await repository.current(row));
      const patches: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
        [() => db.dashboardUser.update({where: {id: user.id}, data: {role: 'MEMBER'}}), () => db.dashboardUser.update({where: {id: user.id}, data: {role: 'ORG_ADMIN'}})],
        [() => db.dashboardUser.update({where: {id: user.id}, data: {organizationId: other.id}}), () => db.dashboardUser.update({where: {id: user.id}, data: {organizationId: org.id}})],
        [() => db.dashboardUser.update({where: {id: user.id}, data: {tokenVersion: 1}}), () => db.dashboardUser.update({where: {id: user.id}, data: {tokenVersion: 0}})],
        [() => db.authSession.update({where: {id: session.id}, data: {revokedAt: new Date()}}), () => db.authSession.update({where: {id: session.id}, data: {revokedAt: null}})],
        [() => db.hostMobilePushDevice.update({where: {id: device.id}, data: {expiresAt: new Date(Date.now() - 1)}}), () => db.hostMobilePushDevice.update({where: {id: device.id}, data: {expiresAt: device.expiresAt, updatedAt: device.updatedAt}})],
        [() => db.property.update({where: {id: property.id}, data: {organizationId: other.id}}), () => db.property.update({where: {id: property.id}, data: {organizationId: org.id}})],
        [() => db.operationalIssue.update({where: {id: source.id}, data: {workflowState: 'RESOLVED', actionRequired: false}}), () => db.operationalIssue.update({where: {id: source.id}, data: {workflowState: 'ACTION_REQUIRED', actionRequired: true}})],
      ];
      for (const [change, restore] of patches) {
        const snapshot = (await repository.current(row))!; assert.ok(snapshot);
        await change(); assert.equal(await repository.current(row), null); assert.equal(await repository.arm(row, snapshot), false);
        await restore();
      }
      const snapshot = (await repository.current(row))!;
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {enabled: false, revision: {increment: 1}}});
      assert.equal(await repository.arm(row, snapshot), false);
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {enabled: true, revision: {increment: 1}}});
      const fresh = (await repository.current(row))!;
      assert.equal(await repository.arm(row, fresh), true);
      await db.hostMobilePushDelivery.update({where: {id: row.id}, data: {leaseUntil: new Date(Date.now() - 1)}});
      await repository.recover();
      assert.equal((await db.hostMobilePushDelivery.findUniqueOrThrow({where: {id: row.id}})).state, 'UNKNOWN');
      assert.equal(await repository.finish(row, {state: 'QUEUED', code: 'STALE_REPLAY'}), false);
      assert.equal(await repository.claim('SEND', 'replacement'), null);
      assert.equal(await enqueue(), 0, 'unknown send remains deduplicated');
      await db.operationalIssue.update({where: {id: source.id}, data: {reopenedCount: {increment: 1}}});
      assert.equal(await enqueue(), 1, 'a new incident episode has a distinct durable identity');
      await clear();
    });
    await t.test('unattended push survives idle and absolute HTTP deadlines but never revocation', async () => {
      for (const age of [31 * 60_000, 13 * 3600_000]) {
        const authenticatedAt = new Date(Date.now() - age - 60_000);
        const lastActivityAt = new Date(Date.now() - age);
        await db.authSession.update({where: {id: session.id}, data: {
          authenticatedAt, lastActivityAt, absoluteExpiresAt: new Date(Date.now() - 1), revokedAt: null,
        }});
        await issue(); await enqueue();
        const row = (await repository.claim('SEND', 'unattended'))!;
        const snapshot = (await repository.current(row))!;
        assert.ok(snapshot, 'registered device remains authorized while app is idle');
        assert.equal(await repository.arm(row, snapshot), true, 'atomic fence uses device lifetime too');
        assert.equal((await db.authSession.findUniqueOrThrow({where: {id: session.id}})).lastActivityAt.getTime(), lastActivityAt.getTime());
        await clear();
      }
      for (const revokeReason of ['LOGOUT', 'IDLE_TIMEOUT', 'ABSOLUTE_TIMEOUT', 'SECURITY_REVOKED']) {
        await db.authSession.update({where: {id: session.id}, data: {revokedAt: null, revokeReason: null}});
        await issue(); await enqueue();
        const row = (await repository.claim('SEND', 'revocation'))!;
        const snapshot = (await repository.current(row))!;
        assert.ok(snapshot);
        await db.authSession.update({where: {id: session.id}, data: {revokedAt: new Date(), revokeReason}});
        assert.equal(await repository.current(row), null);
        assert.equal(await repository.arm(row, snapshot), false, 'revocation after snapshot blocks network send');
        await clear();
      }
      await db.authSession.update({where: {id: session.id}, data: {
        authenticatedAt: session.authenticatedAt, lastActivityAt: session.lastActivityAt,
        absoluteExpiresAt: session.absoluteExpiresAt, revokedAt: null, revokeReason: null,
      }});
    });
    await t.test('pre-send leases can recover but stale owners cannot arm; rebindings invalidate old work', async () => {
      await issue(); await enqueue(); const old = (await repository.claim('SEND', 'old-owner'))!;
      const snapshot = (await repository.current(old))!;
      await db.hostMobilePushDelivery.update({where: {id: old.id}, data: {leaseUntil: new Date(Date.now() - 1)}});
      await repository.recover(); const next = (await repository.claim('SEND', 'next-owner'))!;
      assert.equal(next.leaseEpoch, old.leaseEpoch + 1);
      assert.equal(await repository.arm(old, snapshot), false);
      await registry.register({...actor, sessionId: 'replacement-session'}, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
      // Timestamp precision is not an ownership generation. Force the same
      // timestamp to prove the monotonic binding version still rejects it.
      await db.hostMobilePushDevice.update({where: {id: device.id}, data: {updatedAt: next.deviceUpdatedAt}});
      assert.equal(await repository.current(next), null);
      assert.equal(await repository.arm(next, snapshot), false);
      // Restore the original binding for subsequent isolated subtests.
      await registry.register(actor, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
      await clear();
    });
    await t.test('full synthetic cycle accepts a ticket, recovers a receipt and never resends it', async () => {
      await issue(); let sends = 0, receipts = 0;
      const run = () => runHostPushDeliveryCycle({env, repository, provider: () => ({
        send: async (_token, payload) => {sends++; assert.equal(_token, token); assert.doesNotMatch(JSON.stringify(payload), /PRIVATE/); return {state: 'ACCEPTED', ticketId: 'synthetic-ticket'};},
        receipt: async () => {receipts++; return {state: 'PROVIDER_ACCEPTED'};},
      })});
      await run(); assert.equal(sends, 1); assert.equal(receipts, 0);
      const row = await db.hostMobilePushDelivery.findFirstOrThrow({where: {organizationId: org.id}});
      assert.equal(row.state, 'ACCEPTED');
      await db.hostMobilePushDelivery.update({where: {id: row.id}, data: {availableAt: new Date(Date.now() - 1)}});
      await run(); await run(); assert.equal(sends, 1); assert.equal(receipts, 1);
      assert.equal((await db.hostMobilePushDelivery.findUniqueOrThrow({where: {id: row.id}})).state, 'PROVIDER_ACCEPTED');
      await clear();
    });
    await t.test('device retirement is conditional on the original binding and receipt reads survive a crash', async () => {
      await issue(); await enqueue(); const row = (await repository.claim('SEND', 'send-owner'))!;
      assert.equal(await repository.arm(row, (await repository.current(row))!), true);
      assert.equal(await repository.finish(row, {state: 'ACCEPTED', code: 'EXPO_ACCEPTED', ticketId: 'ticket'}), true);
      const receipt = (await repository.claim('RECEIPT', 'receipt-owner'))!;
      await db.hostMobilePushDelivery.update({where: {id: row.id}, data: {leaseUntil: new Date(Date.now() - 1)}});
      await repository.recover(); const replacement = (await repository.claim('RECEIPT', 'receipt-replacement'))!;
      assert.equal(await repository.finish(receipt, {state: 'FAILED', code: 'DEVICE_NOT_REGISTERED', retireDevice: true}), false);
      await registry.register(actor, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
      assert.equal(await repository.finish(replacement, {state: 'FAILED', code: 'DEVICE_NOT_REGISTERED', retireDevice: true}), true);
      assert.equal((await db.hostMobilePushDevice.findUniqueOrThrow({where: {id: device.id}})).revokedAt, null, 'new binding must not be retired by an old receipt');
      await clear();
    });
    await t.test('only host-action incident/cleaning/access sources enqueue; waiting, internal and messaging failures do not', async () => {
      await issue('Cleaning', 'CLEANING'); await issue('ACCESS', 'ACCESS');
      await issue('Messaging', 'MESSAGING'); const waiting = await issue(); const internal = await issue();
      await db.operationalIssue.update({where: {id: waiting.id}, data: {workflowState: 'WAITING'}});
      await db.operationalIssue.update({where: {id: internal.id}, data: {visibility: 'SYSTEM'}});
      assert.equal(await enqueue(), 2);
      assert.deepEqual((await db.hostMobilePushDelivery.findMany({where: {organizationId: org.id}, select: {kind: true}})).map(x => x.kind).sort(), ['ACCESS_EXCEPTION', 'CLEANING_EXCEPTION']);
      await clear();
    });
    await t.test('current quiet hours block the database send boundary and critical bypass requires explicit opt-in', async () => {
      const source = await issue(); await enqueue(); const row = (await repository.claim('SEND', 'quiet-owner'))!;
      const snapshot = (await repository.current(row))!;
      const hour = snapshot.checkedAt.getUTCHours();
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {quietStartHour: hour, quietEndHour: (hour + 2) % 24, allowCritical: false, revision: {increment: 1}}});
      assert.equal(await repository.arm(row, (await repository.current(row))!), false);
      await db.operationalIssue.update({where: {id: source.id}, data: {severity: 'CRITICAL'}});
      assert.equal(await repository.arm(row, (await repository.current(row))!), false);
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {allowCritical: true, revision: {increment: 1}}});
      assert.equal(await repository.arm(row, (await repository.current(row))!), true);
      assert.equal(await repository.finish(row, {state: 'FAILED', code: 'DEVICE_NOT_REGISTERED', retireDevice: true}), true);
      assert.ok((await db.hostMobilePushDevice.findUniqueOrThrow({where: {id: device.id}})).revokedAt);
      await registry.register(actor, {token, platform: 'ios', projectId: HOST_PUSH_PROJECT});
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {quietStartHour: null, quietEndHour: null, allowCritical: false, revision: {increment: 1}}});
      await clear();
    });
    await t.test('expired event and missing final receipt become terminal without replay or human-session renewal', async () => {
      await issue(); await enqueue(); const row = await db.hostMobilePushDelivery.findFirstOrThrow({where: {organizationId: org.id}});
      await db.hostMobilePushDelivery.update({where: {id: row.id}, data: {expiresAt: new Date(Date.now() - 1)}});
      await repository.recover(); assert.equal((await db.hostMobilePushDelivery.findUniqueOrThrow({where: {id: row.id}})).state, 'SKIPPED');
      await db.hostMobilePushDelivery.update({where: {id: row.id}, data: {state: 'ACCEPTED', ticketId: 'missing', receiptDeadline: new Date(Date.now() - 1)}});
      await repository.recover(); assert.equal((await db.hostMobilePushDelivery.findUniqueOrThrow({where: {id: row.id}})).state, 'UNKNOWN');
      assert.equal(await repository.claim('SEND', 'cannot-replay'), null);
      assert.equal((await db.authSession.findUniqueOrThrow({where: {id: session.id}})).lastActivityAt.getTime(), session.lastActivityAt.getTime());
      await clear();
    });
    await t.test('canonical inbound attention is deduplicated, default-off and fenced by current source/thread authority', async () => {
      const threadId = randomUUID(), messageId = randomUUID();
      const thread = await db.channexAIThread.create({data: {organizationId: org.id, propertyId: property.id, threadId,
        mode: 'HUMAN', since: new Date(now.getTime() - 60_000)}});
      const inbound = await db.channexAIInbound.create({data: {organizationId: org.id, propertyId: property.id, threadId, messageId,
        status: 'NEEDS_HOST', receivedAt: new Date(Date.now() - 1000)}});
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {kinds: ['GUEST_MESSAGE']}});
      const messages = createHostPushDeliveryRepository(db, true);
      const enqueueMessages = () => messages.materialize([property.id], new Date(env.HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE));
      assert.equal(await enqueue(), 0, 'default repository never reads inbound sources');
      await Promise.all([enqueueMessages(), enqueueMessages()]);
      const row = (await messages.claim('SEND', 'inbound-owner'))!;
      assert.equal(row.kind, 'GUEST_MESSAGE'); assert.equal(row.sourceId, `inbound:${inbound.id}`);
      assert.equal(await enqueueMessages(), 0);
      assert.equal(await repository.current(row), null, 'disabling messages also denies queued work');
      const snapshot = (await messages.current(row))!;
      assert.equal(await messages.arm(row, snapshot), false, 'local metadata is insufficient to authorize a message push');
      snapshot.messageVerifiedAt = new Date();
      await db.channexAIThread.update({where: {id: thread.id}, data: {mode: 'AUTO'}});
      assert.equal(await messages.current(row), null); assert.equal(await messages.arm(row, snapshot), false);
      await db.channexAIThread.update({where: {id: thread.id}, data: {mode: 'HUMAN', sending: true}});
      assert.equal(await messages.current(row), null);
      await db.channexAIThread.update({where: {id: thread.id}, data: {sending: false}});
      await db.channexAIInbound.update({where: {id: inbound.id}, data: {status: 'SENT'}});
      assert.equal(await messages.current(row), null); assert.equal(await messages.arm(row, snapshot), false);
      await db.channexAIInbound.update({where: {id: inbound.id}, data: {status: 'NEEDS_HOST'}});
      const fresh = (await messages.current(row))!;
      fresh.messageVerifiedAt = new Date(Date.now() - 6000);
      assert.equal(await messages.arm(row, fresh), false, 'external evidence expires after five seconds');
      fresh.messageVerifiedAt = new Date();
      const readKey = {organizationId: org.id, userId: user.id, propertyId: property.id, threadId, messageId};
      await db.hostMobileMessageRead.create({data: {...readKey, userId: 'another-host'}});
      assert.ok(await messages.current(row), 'another Host reading cannot suppress this recipient');
      await Promise.all(Array.from({length: 4}, () => createMobileMessageReads(db).mark(readKey, messageId,
        [{id: messageId, sender: 'guest', text: 'synthetic', insertedAt: now.toISOString(), attachments: []}])));
      assert.equal(await db.hostMobileMessageRead.count({where: readKey}), 1);
      assert.equal(await messages.current(row), null);
      assert.equal(await messages.arm(row, fresh), false, 'reading after verification cancels the pending send');
      await db.hostMobileMessageRead.deleteMany({where: {organizationId: org.id}});
      assert.equal(await messages.arm(row, fresh), true);
      assert.equal(await messages.finish(row, {state: 'UNKNOWN', code: 'SYNTHETIC'}), true);
      assert.equal(await enqueueMessages(), 0);
      await db.channexAIInbound.delete({where: {id: inbound.id}});
      await db.channexAIThread.delete({where: {id: thread.id}});
      await db.hostMobilePushPreference.update({where: {userId: user.id}, data: {kinds: ['GUEST_INCIDENT', 'CLEANING_EXCEPTION', 'ACCESS_EXCEPTION']}});
      await clear();
    });
    await t.test('bounded maintenance preserves live identities, uncertain sends, pending receipts and tenant isolation', async () => {
      await issue(); await enqueue();
      const original = await db.hostMobilePushDelivery.findFirstOrThrow({where: {organizationId: org.id}});
      const old = new Date(Date.now() - 31 * 86400000);
      const aged = {...original, state: 'FAILED', expiresAt: old, updatedAt: old};
      await db.hostMobilePushDelivery.update({where: {id: original.id}, data: {state: 'FAILED', expiresAt: old, updatedAt: old}});
      const protectedRows = ['UNKNOWN', 'ACCEPTED', 'CHECKING', 'SENDING', 'CLAIMED', 'QUEUED'].map(state =>
        ({...aged, id: randomUUID(), sourceId: randomUUID(), state}));
      protectedRows.push({...aged, id: randomUUID(), sourceId: randomUUID(), state: 'FAILED', kind: 'GUEST_MESSAGE'});
      protectedRows.push({...aged, id: randomUUID(), sourceId: randomUUID(), state: 'FAILED', updatedAt: new Date()});
      protectedRows.push({...aged, id: randomUUID(), sourceId: randomUUID(), state: 'FAILED', organizationId: other.id});
      await db.hostMobilePushDelivery.createMany({data: protectedRows});
      await db.hostMobilePushDelivery.createMany({data: Array.from({length: 501}, (_, n) =>
        ({...aged, id: randomUUID(), sourceId: randomUUID(), state: ['FAILED','SKIPPED','PROVIDER_ACCEPTED'][n % 3]}))});
      const activeDevice = await db.hostMobilePushDevice.findUniqueOrThrow({where: {id: device.id}});
      const expiredDevice = {...activeDevice, id: randomUUID(), tokenHash: randomUUID(), expiresAt: old, updatedAt: old};
      const renewedDevice = {...expiredDevice, id: randomUUID(), tokenHash: randomUUID(), updatedAt: new Date()};
      await db.hostMobilePushDevice.createMany({data: [expiredDevice, renewedDevice]});
      assert.deepEqual(await maintainHostPushRecords(db, []), {deliveriesDeleted: 0, devicesDeleted: 0});
      assert.deepEqual(await maintainHostPushRecords(db, [org.id]), {deliveriesDeleted: 500, devicesDeleted: 1});
      const concurrent = await Promise.all([maintainHostPushRecords(db, [org.id]), maintainHostPushRecords(db, [org.id])]);
      assert.equal(concurrent.reduce((sum, r) => sum + r.deliveriesDeleted, 0), 1);
      assert.equal(await db.hostMobilePushDelivery.count({where: {id: {in: [original.id, ...protectedRows.map(r => r.id)]}}}), 10);
      assert.ok(await db.hostMobilePushDevice.findUnique({where: {id: renewedDevice.id}}));
      assert.ok(await db.hostMobilePushDevice.findUnique({where: {id: device.id}}));
      // A fresh signal cannot rematerialize a retained source episode.
      assert.equal(await enqueue(), 0, 'retained identity prevents duplicate notification');
      await db.hostMobilePushDevice.deleteMany({where: {id: {in: [expiredDevice.id, renewedDevice.id]}}});
      await db.hostMobilePushDelivery.deleteMany({where: {organizationId: other.id}});
      await clear();
    });
  } finally {
    await db.hostMobileMessageRead.deleteMany({where: {organizationId: org.id}});
    await db.channexAIInbound.deleteMany({where: {organizationId: org.id}});
    await db.channexAIThread.deleteMany({where: {organizationId: org.id}});
    await clear(); await db.authSession.deleteMany({where: {organizationId: org.id}});
    await db.property.deleteMany({where: {id: property.id}});
    await db.dashboardUser.deleteMany({where: {id: user.id}});
    await db.organization.deleteMany({where: {id: {in: [org.id, other.id]}}}); await db.$disconnect();
  }
});
