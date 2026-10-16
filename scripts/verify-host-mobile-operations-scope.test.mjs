import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHostScope, ALLOWED, BASE, RELATIONS, MODELS } from './verify-host-mobile-operations-scope.mjs';
const repo = 'freddiefernandezmaysonet-netizen/pin-go-backend';
function fixture() {
  const before = 'model DashboardUser {\n  id String @id\n}\nmodel SalesVoiceCall {\n  id String @id\n}\nmodel OtaBooking {\n  id String @id\n}\n';
  return { event: { number: 472, pull_request: {
    head: { ref: 'agent/host-mobile-operations-20261016', repo: { full_name: repo } },
    base: { ref: 'main', sha: BASE, repo: { full_name: repo } }
  } }, paths: [...ALLOWED], before,
  after: before.replace('  id String @id\n}', '  id String @id\n'+RELATIONS+'}') + MODELS };
}
test('exact additive Host scope is admitted without changing sales or OTA', () => {
  assert.doesNotThrow(() => verifyHostScope(fixture()));
});
test('rejects foreign PR, fork, branch, target and changed base', () => {
  for (const mutate of [ f=>f.event.number=473,
    f=>f.event.pull_request.head.repo.full_name='other/fork',
    f=>f.event.pull_request.base.repo.full_name='other/repo',
    f=>f.event.pull_request.head.ref='other-branch',
    f=>f.event.pull_request.base.ref='other-target',
    f=>f.event.pull_request.base.sha='a'.repeat(40) ]) {
    const f=fixture(); mutate(f); assert.throws(()=>verifyHostScope(f));
  }
});
test('rejects unrelated sales or OTA files, missing scope files and duplicates', () => {
  for (const change of [ p=>p.push('src/services/sales-voice-commercial.service.ts'),
    p=>p.push('src/distribution/airbnb.ts'),p=>p.pop(),p=>p.push(p[0]) ]) {
    const f=fixture(); change(f.paths); assert.throws(()=>verifyHostScope(f));
  }
});
test('rejects modifying existing sales, OTA or user schema', () => {
  for (const model of ['SalesVoiceCall','OtaBooking','DashboardUser']) {
    const f=fixture(); f.after=f.after.replace('model '+model+' {','model '+model+' {\n  injected String?');
    assert.throws(()=>verifyHostScope(f));
  }
});
test('rejects altered Host models, missing/duplicate relation blocks and appended models', () => {
  for (const mutate of [s=>s.replace('tokenHash String @unique','tokenHash String'),
    s=>s.replace(RELATIONS,''),s=>s.replace(RELATIONS,RELATIONS+RELATIONS),
    s=>s+'\nmodel Extra { id String @id }\n']) {
    const f=fixture();f.after=mutate(f.after);assert.throws(()=>verifyHostScope(f));
  }
});
