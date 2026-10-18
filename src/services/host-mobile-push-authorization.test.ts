import assert from 'node:assert/strict';
import test from 'node:test';
import {permitsHostPushBinding, type PushSessionBinding} from './host-mobile-push-authorization.js';
import {evaluateSessionSecurity} from '../auth/session-security.policy.js';

const now = new Date('2026-10-18T12:00:00Z');
const expected = {sessionId: 'session', userId: 'host', organizationId: 'org', tokenVersion: 2};
const binding: PushSessionBinding = {id: 'session', userId: 'host', organizationId: 'org', tokenVersion: 2,
  revokedAt: null, authenticatedAt: new Date('2026-10-17T00:00:00Z'), lastActivityAt: new Date('2026-10-17T01:00:00Z')};

test('notification authorization outlives HTTP inactivity without making the HTTP session valid', () => {
  assert.equal(permitsHostPushBinding(binding, expected, now), true);
  assert.equal(evaluateSessionSecurity(binding, now).valid, false);
  assert.equal(binding.lastActivityAt.toISOString(), '2026-10-17T01:00:00.000Z');
});

test('notification binding rejects revocations, identity changes and malformed timelines', () => {
  assert.equal(permitsHostPushBinding(null, expected, now), false);
  const changes: Partial<PushSessionBinding>[] = [
    {revokedAt: now}, {id: 'other'}, {userId: 'other'}, {organizationId: 'other'}, {tokenVersion: 3},
    {authenticatedAt: new Date('invalid')}, {lastActivityAt: new Date('invalid')},
    {lastActivityAt: new Date('2026-10-16T00:00:00Z')}, {lastActivityAt: new Date(now.getTime() + 1)},
  ];
  for (const change of changes) assert.equal(permitsHostPushBinding({...binding, ...change}, expected, now), false);
});
