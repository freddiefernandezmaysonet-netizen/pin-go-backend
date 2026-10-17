import type {VerifyHostPushMessage} from './host-mobile-push-messages.js';
import {randomUUID} from 'node:crypto';
import {prepareHostAttentionNotification} from './host-mobile-notification.policy.js';
import {decryptHostPushToken, type HostPushEnvironment} from './host-mobile-push-token.js';
import type {HostPushProvider} from './host-mobile-push-provider.js';
import type {HostPushDeliveryRepository} from './host-mobile-push-delivery.repository.js';

export type HostPushDeliveryConfig = {enabled: false} | {enabled: true; propertyIds: string[]; notBefore: Date};
export function hostPushDeliveryConfig(env: HostPushEnvironment): HostPushDeliveryConfig {
  if (env.HOST_MOBILE_PUSH_DELIVERY_ENABLED !== 'true') return {enabled: false};
  try {
    const propertyIds: unknown = JSON.parse(env.HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS ?? 'null');
    const rawDate = env.HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE ?? '';
    const notBefore = new Date(rawDate);
    if (!Array.isArray(propertyIds) || propertyIds.length < 1 || propertyIds.length > 50 ||
        propertyIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) ||
        new Set(propertyIds).size !== propertyIds.length || !rawDate.endsWith('Z') || !Number.isFinite(notBefore.getTime())) throw Error();
    return {enabled: true, propertyIds, notBefore};
  } catch { throw Error('HOST_PUSH_DELIVERY_CONFIG_INVALID'); }
}

// Invoked explicitly by a separate process. No API-server import/startup hook.
// Disabled configuration returns before provider creation or database access.
export async function runHostPushDeliveryCycle(input: {
  env: HostPushEnvironment; verifyMessage?: VerifyHostPushMessage; repository: HostPushDeliveryRepository; provider: () => HostPushProvider;
}) {
  const config = hostPushDeliveryConfig(input.env);
  if (!config.enabled) return {enabled: false as const, processed: 0, enqueued: 0};
  const provider = input.provider();
  await input.repository.recover();
  const enqueued = await input.repository.materialize(config.propertyIds, config.notBefore);
  const owner = randomUUID();
  let processed = 0;
  // Receipt work has its own quota; a busy send queue cannot starve it.
  for (const mode of ['RECEIPT', 'SEND'] as const) {
    for (let index = 0; index < 10; index++) {
      const row = await input.repository.claim(mode, owner);
      if (!row) break;
      processed++;
      if (mode === 'RECEIPT') {
        const result = await provider.receipt(row.ticketId!);
        await input.repository.finish(row, result.state === 'PENDING'
          ? {state: 'ACCEPTED', code: 'RECEIPT_PENDING', delayMs: 5 * 60_000}
          : result.state === 'PROVIDER_ACCEPTED'
            ? {state: 'PROVIDER_ACCEPTED', code: 'PROVIDER_ACCEPTED'}
            : {state: 'FAILED', code: result.code, retireDevice: result.code === 'DEVICE_NOT_REGISTERED'});
        continue;
      }
      // Existing rows cannot escape a subsequently narrowed canary scope/cutoff.
      if (!config.propertyIds.includes(row.propertyId) || row.occurredAt < config.notBefore) {
        await input.repository.finish(row, {state: 'SKIPPED', code: 'DELIVERY_SCOPE_CHANGED'});
        continue;
      }
      let snapshot = await input.repository.current(row);
      if (!snapshot) {
        await input.repository.finish(row, {state: 'SKIPPED', code: 'CURRENT_AUTHORITY_DENIED'});
        continue;
      }
      let prepared = prepareHostAttentionNotification(snapshot.event, snapshot.recipient, snapshot.preference, snapshot.checkedAt);
      if (prepared.status !== 'PREPARED') {
        await input.repository.finish(row, prepared.status === 'DEFER'
          ? {state: 'QUEUED', code: 'QUIET_HOURS', delayMs: 15 * 60_000}
          : {state: 'SKIPPED', code: prepared.reason});
        continue;
      }
      let token: string;
      try { token = decryptHostPushToken(snapshot.device, input.env); }
      catch {
        // A missing rotation key is configuration failure, never a send attempt.
        await input.repository.finish(row, {state: 'QUEUED', code: 'TOKEN_UNAVAILABLE', delayMs: 15 * 60_000});
        continue;
      }
      if (row.kind === 'GUEST_MESSAGE') {
        if (input.env.HOST_MOBILE_PUSH_MESSAGES_ENABLED !== 'true' || !input.verifyMessage || !snapshot.message) {
          await input.repository.finish(row, {state: 'SKIPPED', code: 'MESSAGES_DISABLED'}); continue;
        }
        const before = snapshot.message;
        const verified = await input.verifyMessage({organizationId: row.organizationId, propertyId: row.propertyId}, before, config.notBefore)
          .catch(() => ({state: 'DEFER'} as const));
        if (verified.state !== 'READY') {
          await input.repository.finish(row, verified.state === 'SKIP'
            ? {state: 'SKIPPED', code: 'MESSAGE_NO_LONGER_ACTIONABLE'}
            : {state: 'QUEUED', code: 'MESSAGE_VERIFICATION_UNAVAILABLE', delayMs: 5 * 60_000});
          continue;
        }
        // Network reads do not hold a DB transaction. Re-read all local authority
        // afterward and require the same exact source/thread revisions.
        snapshot = await input.repository.current(row);
        if (!snapshot || !snapshot.message || JSON.stringify(snapshot.message) !== JSON.stringify(before)) {
          await input.repository.finish(row, {state: 'QUEUED', code: 'MESSAGE_AUTHORITY_CHANGED', delayMs: 5 * 60_000}); continue;
        }
        prepared = prepareHostAttentionNotification(snapshot.event, snapshot.recipient, snapshot.preference, snapshot.checkedAt);
        if (prepared.status !== 'PREPARED') {
          await input.repository.finish(row, {state: 'QUEUED', code: 'MESSAGE_POLICY_CHANGED', delayMs: 5 * 60_000}); continue;
        }
        snapshot.messageVerifiedAt = verified.verifiedAt;
      }
      if (!await input.repository.arm(row, snapshot)) continue;
      // SENDING is durable before the first network byte. Any exception/crash
      // leaves an uncertain attempt that recovery will never automatically send.
      const result = await provider.send(token, prepared.payload, row.expiresAt).catch(() =>
        ({state: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN'} as const));
      if (result.state === 'ACCEPTED') {
        await input.repository.finish(row, {state: 'ACCEPTED', code: 'EXPO_ACCEPTED', ticketId: result.ticketId, delayMs: 15 * 60_000});
      } else if (result.state === 'RETRY') {
        await input.repository.finish(row, row.attempts < 2
          ? {state: 'QUEUED', code: result.code, delayMs: 60_000 * 2 ** row.attempts}
          : {state: 'FAILED', code: 'RATE_LIMIT_RETRY_EXHAUSTED'});
      } else {
        await input.repository.finish(row, {state: result.state, code: result.code,
          retireDevice: result.state === 'FAILED' && result.code === 'DEVICE_NOT_REGISTERED'});
      }
    }
  }
  return {enabled: true as const, processed, enqueued};
}
