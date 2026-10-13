import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';

// This suite may only touch the disposable database created by its CI job.
// It does not import application routes, workers, OpenAI, Twilio, or Stripe.
const databaseUrl = process.env.SALES_VOICE_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'A dedicated test database URL is required');
const target = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Local database only');
assert.equal(target.protocol, 'postgresql:');
assert.equal(target.pathname, '/pingo_sales_voice_crm_test');
assert.equal(process.env.DATABASE_URL, databaseUrl, 'Conflicting database configuration');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
after(async () => { await db.$disconnect(); });
const baselineId = 'sales-voice-baseline-sentinel';
const baselineDate = new Date('2026-01-01T00:00:00.000Z');
const isPrismaError = code => error => error?.code === code;

async function assertBaseline() {
  const organization = await db.organization.findUniqueOrThrow({ where: { id: baselineId } });
  assert.equal(organization.name, 'Sales voice baseline - do not change');
  assert.deepEqual(organization.createdAt, baselineDate);
  assert.deepEqual(organization.updatedAt, baselineDate);
  assert.equal(await db.reservation.count(), 0);
  assert.equal(await db.pendingSignup.count(), 0);
  assert.equal(await db.onboardingAppointment.count(), 0);
  assert.equal(await db.salesFollowUp.count(), 0);
}

await test('Sales voice foundation on the actual SQL migration', async t => {
  await t.test('preserves pre-existing organization data and operational tables', assertBaseline);

  await t.test('generated client exposes metadata only, without credential or recording fields', () => {
    const expected = {
      SalesProspect: ['id', 'fullName', 'email', 'phoneE164', 'organizationName', 'propertyCount', 'preferredLanguage', 'source', 'status', 'contactConsentAt', 'marketingConsentAt', 'marketingConsentSource', 'convertedOrganizationId', 'convertedAt', 'createdAt', 'updatedAt'],
      SalesVoiceCall: ['id', 'prospectId', 'provider', 'providerCallId', 'direction', 'fromPhoneE164', 'toPhoneE164', 'language', 'status', 'disposition', 'startedAt', 'answeredAt', 'endedAt', 'durationSeconds', 'lastUsageSeconds', 'usageObservedAt', 'finalUsageSeconds', 'finalizedAt', 'closeReason', 'hangupClaimedAt', 'hangupAcknowledgedAt', 'createdAt', 'updatedAt'],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const model = Prisma.dmmf.datamodel.models.find(value => value.name === name);
      assert.ok(model, `${name} must be generated`);
      assert.deepEqual(model.fields.filter(field => field.kind === 'scalar').map(field => field.name).sort(), [...fields].sort());
    }
  });

  await t.test('creates an independent prospect without an appointment or account', async () => {
    const prospect = await db.salesProspect.create({ data: {} });
    assert.ok(prospect.id);
    assert.equal(prospect.source, 'PHONE');
    assert.equal(prospect.status, 'NEW');
    assert.equal(prospect.convertedOrganizationId, null);
    assert.equal(prospect.contactConsentAt, null);
    assert.equal(prospect.marketingConsentAt, null);
  });

  await t.test('round-trips language and property count for both supported languages', async () => {
    for (const preferredLanguage of ['es', 'en']) {
      const prospect = await db.salesProspect.create({ data: { preferredLanguage, propertyCount: 5 } });
      const read = await db.salesProspect.findUniqueOrThrow({ where: { id: prospect.id } });
      assert.equal(read.preferredLanguage, preferredLanguage);
      assert.equal(read.propertyCount, 5);
    }
  });

  await t.test('contact consent does not implicitly grant marketing consent', async () => {
    const prospect = await db.salesProspect.create({ data: { contactConsentAt: baselineDate } });
    assert.deepEqual(prospect.contactConsentAt, baselineDate);
    assert.equal(prospect.marketingConsentAt, null);
    assert.equal(prospect.marketingConsentSource, null);
  });

  await t.test('shared caller ID does not force two people into the same prospect', async () => {
    const data = { phoneE164: '+12025550101', email: 'shared@example.invalid' };
    const a = await db.salesProspect.create({ data });
    const b = await db.salesProspect.create({ data });
    assert.notEqual(a.id, b.id);
    assert.equal(a.convertedOrganizationId, null);
    assert.equal(b.convertedOrganizationId, null);
  });

  await t.test('accepts anonymous inbound call metadata without creating a prospect', async () => {
    const before = await db.salesProspect.count();
    const call = await db.salesVoiceCall.create({ data: {} });
    assert.equal(call.fromPhoneE164, null);
    assert.equal(call.prospectId, null);
    assert.equal(call.direction, 'INBOUND');
    assert.equal(call.provider, 'TWILIO');
    assert.equal(call.status, 'RECEIVED');
    assert.equal(await db.salesProspect.count(), before);
  });

  await t.test('retains distinct calls even when their caller ID matches', async () => {
    const fromPhoneE164 = '+12025550101';
    const a = await db.salesVoiceCall.create({ data: { fromPhoneE164, providerCallId: 'fixture-distinct-a' } });
    const b = await db.salesVoiceCall.create({ data: { fromPhoneE164, providerCallId: 'fixture-distinct-b' } });
    assert.notEqual(a.id, b.id);
  });

  await t.test('concurrent duplicate provider call IDs create exactly one call record', async () => {
    const providerCallId = 'fixture-concurrent-call';
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => db.salesVoiceCall.create({ data: { providerCallId } })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failures = results.filter(result => result.status === 'rejected');
    assert.equal(failures.length, 7);
    for (const failure of failures) assert.equal(failure.reason.code, 'P2002');
    assert.equal(await db.salesVoiceCall.count({ where: { providerCallId } }), 1);
  });

  await t.test('rejects linking a call to a nonexistent prospect', async () => {
    await assert.rejects(db.salesVoiceCall.create({ data: { prospectId: 'fixture-missing-prospect' } }), isPrismaError('P2003'));
  });

  await t.test('rejects linking a conversion to a nonexistent organization', async () => {
    await assert.rejects(db.salesProspect.create({ data: { convertedOrganizationId: 'fixture-missing-organization' } }), isPrismaError('P2003'));
  });

  await t.test('links a conversion without changing the existing customer organization', async () => {
    const prospect = await db.salesProspect.create({ data: { convertedOrganizationId: baselineId, convertedAt: baselineDate }, include: { convertedOrganization: true } });
    assert.equal(prospect.convertedOrganization.id, baselineId);
    assert.deepEqual(prospect.convertedAt, baselineDate);
    await assertBaseline();
  });

  await t.test('deleting a converted organization retains the prospect history', async () => {
    const organization = await db.organization.create({ data: { name: 'Disposable conversion fixture' } });
    const prospect = await db.salesProspect.create({ data: { convertedOrganizationId: organization.id, convertedAt: baselineDate } });
    await db.organization.delete({ where: { id: organization.id } });
    const retained = await db.salesProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    assert.equal(retained.convertedOrganizationId, null);
    assert.deepEqual(retained.convertedAt, baselineDate);
  });

  await t.test('deleting a prospect retains call metadata without a dangling reference', async () => {
    const prospect = await db.salesProspect.create({ data: {} });
    const call = await db.salesVoiceCall.create({ data: { prospectId: prospect.id, providerCallId: 'fixture-retained-call' } });
    await db.salesProspect.delete({ where: { id: prospect.id } });
    const retained = await db.salesVoiceCall.findUniqueOrThrow({ where: { id: call.id } });
    assert.equal(retained.prospectId, null);
    assert.equal(retained.providerCallId, 'fixture-retained-call');
  });

  await t.test('stores completion metadata and updates its audit timestamp', async () => {
    const call = await db.salesVoiceCall.create({ data: { startedAt: baselineDate, updatedAt: baselineDate } });
    const endedAt = new Date(baselineDate.getTime() + 90000);
    const completed = await db.salesVoiceCall.update({ where: { id: call.id }, data: { status: 'COMPLETED', disposition: 'INFORMATION_PROVIDED', answeredAt: baselineDate, endedAt, durationSeconds: 90, language: 'es' } });
    assert.equal(completed.id, call.id);
    assert.equal(completed.durationSeconds, 90);
    assert.deepEqual(completed.endedAt, endedAt);
    assert.ok(completed.updatedAt.getTime() > baselineDate.getTime());
    await assertBaseline();
  });

  await t.test('the SQL migration installs all seven intended secondary indexes', async () => {
    const indexes = await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('SalesProspect', 'SalesVoiceCall')`;
    const actual = indexes.map(row => row.indexname).filter(name => !name.endsWith('_pkey')).sort();
    const expected = ['SalesProspect_status_createdAt_idx', 'SalesProspect_email_idx', 'SalesProspect_phoneE164_idx', 'SalesProspect_convertedOrganizationId_idx', 'SalesVoiceCall_providerCallId_key', 'SalesVoiceCall_prospectId_startedAt_idx', 'SalesVoiceCall_status_startedAt_idx'].sort();
    assert.deepEqual(actual, expected);
  });
});
