import {buildHostPushMessageVerifier} from '../services/host-mobile-push-messages.js';
import {setTimeout as delay} from 'node:timers/promises';
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
      repository: createHostPushDeliveryRepository(db, !!verifyMessage, env.HOST_MOBILE_PUSH_RESERVATIONS_ENABLED === 'true'), provider: () => provider});
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
// Serial cycles: no overlap and no automatic replay of uncertain sends.
export async function runLoop(env: Readonly<Record<string,string|undefined>>, signal: AbortSignal,
  cycle = runOnce, pause = (signal:AbortSignal)=>delay(15000,undefined,{signal})) {
  if (!hostPushDeliveryConfig(env).enabled) throw Error('HOST_PUSH_LOOP_DISABLED');
  while (!signal.aborted) {
    try {
      const result=await cycle(env);
      if(result.processed || result.enqueued)console.log('[HOST_PUSH_CYCLE]',result);
    } catch {console.error('[HOST_PUSH_CYCLE] unavailable');}
    if(!signal.aborted)await pause(signal).catch(error=>{if(!signal.aborted)throw error;});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!['--once', '--maintenance-once', '--loop'].includes(process.argv[2] ?? '') || process.argv.length !== 3) throw Error('HOST_PUSH_EXPLICIT_MODE_REQUIRED');
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const work=process.argv[2]==='--loop'?runLoop(process.env,controller.signal):
    (process.argv[2] === '--maintenance-once' ? runMaintenance(process.env) : runOnce(process.env)).then(result => console.log('[HOST_PUSH_CYCLE]', result));
  work.catch(() => {console.error('[HOST_PUSH_CYCLE] unavailable'); process.exitCode = 1;})
    .finally(()=>{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);});
}
