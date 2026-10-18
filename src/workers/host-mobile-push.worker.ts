import {buildHostPushMessageVerifier} from '../services/host-mobile-push-messages.js';
import {pathToFileURL} from 'node:url';
import {hostPushDeliveryConfig, runHostPushDeliveryCycle} from '../services/host-mobile-push-delivery.service.js';
import {createHostPushDeliveryRepository, maintainHostPushRecords} from '../services/host-mobile-push-delivery.repository.js';
import {createExpoHostPushProvider} from '../services/host-mobile-push-provider.js';

export async function runOnce(env: Readonly<Record<string, string | undefined>>) {
  if (!hostPushDeliveryConfig(env).enabled) return {enabled: false, processed: 0, enqueued: 0};
  // Validate provider configuration before connecting to the database.
  const provider = createExpoHostPushProvider(env.HOST_MOBILE_PUSH_EXPO_ACCESS_TOKEN ?? '');
  const {PrismaClient} = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const verifyMessage = buildHostPushMessageVerifier(db, env);
    return await runHostPushDeliveryCycle({env, verifyMessage,
      repository: createHostPushDeliveryRepository(db, !!verifyMessage), provider: () => provider});
  }
  finally { await db.$disconnect(); }
}
// Independent flag and exact tenant scope: delivery activation never enables cleanup.
export async function runMaintenance(env: Readonly<Record<string, string | undefined>>) {
  if (env.HOST_MOBILE_PUSH_MAINTENANCE_ENABLED !== 'true')
    return {enabled: false, deliveriesDeleted: 0, devicesDeleted: 0};
  let ids: unknown;
  try { ids = JSON.parse(env.HOST_MOBILE_PUSH_MAINTENANCE_ORGANIZATION_IDS ?? 'null'); } catch {}
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) || new Set(ids).size !== ids.length)
    throw Error('HOST_PUSH_MAINTENANCE_CONFIG_INVALID');
  const {PrismaClient} = await import('@prisma/client');
  const db = new PrismaClient();
  try { return {enabled: true, ...await maintainHostPushRecords(db, ids)}; }
  finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!['--once', '--maintenance-once'].includes(process.argv[2] ?? '') || process.argv.length !== 3) throw Error('HOST_PUSH_EXPLICIT_ONCE_REQUIRED');
  // Only sanitized aggregate counts. No device, ticket, actor, event or error text.
  (process.argv[2] === '--maintenance-once' ? runMaintenance(process.env) : runOnce(process.env)).then(result => console.log('[HOST_PUSH_CYCLE]', result)).catch(() => {
    console.error('[HOST_PUSH_CYCLE] unavailable'); process.exitCode = 1;
  });
}
