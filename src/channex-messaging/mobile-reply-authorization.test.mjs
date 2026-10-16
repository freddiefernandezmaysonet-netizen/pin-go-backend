import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeMobileReply } from './mobile-reply-authorization.ts';
const input = { enabled: true, authorization: 'Bearer header.payload.signature', identity: { id: 'host', orgId: 'org', sessionId: 'session' } };
const payload = { sub: 'host', orgId: 'org', sid: 'session', tokenVersion: 2 };
const allowed = { kind: 'ALLOW', sessionId: 'session', user: { id: 'host', organizationId: 'org', role: 'ORG_ADMIN' } };
const deps = { verify: () => payload, guard: async args => { assert.equal(args.mode, 'ENFORCE'); return allowed; } };
test('native replies require verified bearer and enforced bound session', async () => {
  await authorizeMobileReply(input, deps);
});
test('disabled flag, browser origin, cookies and malformed bearer fail before verification', async () => {
  for (const change of [{ enabled: false }, { origin: 'https://app.pin-ngo.com' }, { origin: 'null' }, { cookie: '' }, { authorization: undefined }, { authorization: 'Bearer invalid' }]) {
    let calls = 0;
    await assert.rejects(authorizeMobileReply({ ...input, ...change }, { ...deps, verify: () => { calls++; return payload; } }));
    assert.equal(calls, 0);
  }
});
test('invalid signature, legacy token and mismatched identity fail closed', async () => {
  await assert.rejects(authorizeMobileReply(input, { ...deps, verify: () => { throw Error('invalid signature'); } }), e => e.status === 401);
  for (const change of [{ sid: undefined }, { sub: 'other' }, { orgId: 'other' }, { sid: 'other' }]) {
    await assert.rejects(authorizeMobileReply(input, { ...deps, verify: () => ({ ...payload, ...change }) }), e => e.status === 401);
  }
});
test('revoked, expired, unavailable, role changes and guard identity mismatch never allow sending', async () => {
  for (const result of [
    { kind: 'DENY', status: 401, error: 'SESSION_EXPIRED' },
    { kind: 'UNAVAILABLE', status: 503, error: 'SESSION_VALIDATION_UNAVAILABLE' },
    { ...allowed, user: { ...allowed.user, role: 'STAFF' } },
    { ...allowed, sessionId: 'other' },
    { ...allowed, user: { ...allowed.user, organizationId: 'other' } },
  ]) await assert.rejects(authorizeMobileReply(input, { ...deps, guard: async () => result }));
});
