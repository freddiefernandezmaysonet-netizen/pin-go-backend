import {pathToFileURL} from 'node:url';
import {hostPushDeliveryConfig, runHostPushDeliveryCycle} from '../services/host-mobile-push-delivery.service.js';
import {createHostPushDeliveryRepository} from '../services/host-mobile-push-delivery.repository.js';
import {createExpoHostPushProvider} from '../services/host-mobile-push-provider.js';

export async function runOnce(env: Readonly<Record<string, string | undefined>>) {
  if (!hostPushDeliveryConfig(env).enabled) return {enabled: false, processed: 0, enqueued: 0};
  // Validate provider configuration before connecting to the database.
  const provider = createExpoHostPushProvider(env.HOST_MOBILE_PUSH_EXPO_ACCESS_TOKEN ?? '');
  const {PrismaClient} = await import('@prisma/client');
  const db = new PrismaClient();
  try { return await runHostPushDeliveryCycle({env, repository: createHostPushDeliveryRepository(db), provider: () => provider}); }
  finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--once' || process.argv.length !== 3) throw Error('HOST_PUSH_EXPLICIT_ONCE_REQUIRED');
  // Only sanitized aggregate counts. No device, ticket, actor, event or error text.
  runOnce(process.env).then(result => console.log('[HOST_PUSH_CYCLE]', result)).catch(() => {
    console.error('[HOST_PUSH_CYCLE] unavailable'); process.exitCode = 1;
  });
}
