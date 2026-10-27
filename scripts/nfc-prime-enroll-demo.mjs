// One-card, time-limited hardware pilot. Database reads only; add to Demo only.
// cardNumber stays inside this process. No provider credentials or UIDs in logs.
import { checkedBase, providerRead, publicCard, DEMO_PROPERTY_ID } from './nfc-prime-preflight.mjs';

export const PILOT_LOCK_ID = 29944630;
export const SOURCE_LOCK_ID = 25439884;
export const SOURCE_CARD_ID = 179837558;
export const PILOT_LABEL = 'Prime Pilot 20261027-837558';
const ADD_PATH = '/v3/identityCard/add';
// Official TTLock SDK uses this endpoint with its native cardNumber:
// https://github.com/ttlock/Android_SDK_Demo/blob/master/app/src/main/java/ttlock/demo/retrofit/ApiService.java

function fail(code) { throw new Error(code); }
function numberOf(card) {
  const value = String(card?.cardNumber ?? '');
  if (!/^\d{1,20}$/.test(value) || BigInt(value) <= 0n) fail('CARD_NUMBER_UNAVAILABLE');
  return value;
}

export function checkWindow(startDate, endDate, now = Date.now()) {
  if (!Number.isSafeInteger(startDate) || !Number.isSafeInteger(endDate)
      || startDate <= 0 || startDate % 60000 || endDate % 60000
      || endDate <= startDate || endDate - startDate > 30 * 60000
      || startDate > now + 5 * 60000 || startDate < now - 5 * 60000
      || endDate < now + 5 * 60000) fail('INVALID_PILOT_WINDOW');
}

export function planEnrollment(sourceCards, targetCards, startDate, endDate) {
  const source = sourceCards.filter(c => Number(c.cardId) === SOURCE_CARD_ID);
  if (source.length !== 1) fail('SOURCE_CARD_NOT_UNIQUE');
  const cardNumber = numberOf(source[0]);
  const sameNumber = targetCards.filter(c => BigInt(numberOf(c)) === BigInt(cardNumber));
  const sameLabel = targetCards.filter(c => c.cardName === PILOT_LABEL);
  if (sameNumber.length || sameLabel.length) {
    if (sameNumber.length === 1 && sameLabel.length === 1 && sameNumber[0] === sameLabel[0]
        && Number(sameNumber[0].startDate) === startDate && Number(sameNumber[0].endDate) === endDate) {
      return { state: 'ALREADY_PRESENT', cardNumber, card: sameNumber[0] };
    }
    fail('TARGET_CARD_ALREADY_PRESENT');
  }
  return { state: 'READY', cardNumber, source: source[0] };
}

async function cardsFor(config, lockId) {
  const cards = [];
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const page = await providerRead(config, '/v3/identityCard/list', {
      lockId: String(lockId), pageNo: String(pageNo), pageSize: '100',
    });
    if (!Array.isArray(page.list)) fail('INVALID_CARD_LIST');
    cards.push(...page.list);
    if (page.list.length < 100) return cards;
  }
  fail('INCOMPLETE_CARD_LIST');
}

export async function addPilot(config, cardNumber, startDate, endDate, fetcher = fetch) {
  checkWindow(startDate, endDate);
  numberOf({cardNumber});
  const base = checkedBase(config.base);
  if (!config.clientId || !config.accessToken) fail('TTLOCK_AUTH_MISSING');
  const response = await fetcher(`${base}${ADD_PATH}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({clientId: config.clientId, accessToken: config.accessToken,
      lockId: String(PILOT_LOCK_ID), cardNumber, cardName: PILOT_LABEL,
      startDate: String(startDate), endDate: String(endDate), addType: '2', date: String(Date.now())}),
  });
  if (!response.ok) fail(`TTLOCK_HTTP_${response.status}`);
  const data = await response.json();
  if (data?.errcode != null && Number(data.errcode) !== 0) {
    fail(`TTLOCK_CODE_${Number.isSafeInteger(Number(data.errcode)) ? Number(data.errcode) : 'UNKNOWN'}`);
  }
  if (!Number.isSafeInteger(data?.cardId) || data.cardId <= 0) fail('ADD_RESPONSE_UNCONFIRMED');
  return data.cardId;
}

export async function runPilot(env = process.env) {
  if (!env.DATABASE_URL || !env.TTLOCK_CLIENT_ID) fail('PILOT_NOT_CONFIGURED');
  const startDate = Number(env.NFC_PRIME_START_MS);
  const endDate = Number(env.NFC_PRIME_END_MS);
  checkWindow(startDate, endDate);
  const base = checkedBase(env.TTLOCK_API_BASE);
  const url = new URL(env.DATABASE_URL);
  if (url.searchParams.get('schema') && url.searchParams.get('schema') !== 'public') fail('UNSUPPORTED_DATABASE_SCHEMA');
  url.searchParams.delete('schema');
  const { SQL } = await import('bun');
  const sql = new SQL(url.toString(), {max: 1, connectionTimeout: 10, idleTimeout: 5});
  let auth;
  try {
    auth = await sql.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '10000ms'`;
      const rows = await tx`
        SELECT l."ttlockLockId", l."isActive", p.id AS "propertyId", p."organizationId", p."isTestProperty", p.status
        FROM "Lock" l JOIN "Property" p ON p.id = l."propertyId"
        WHERE l."ttlockLockId" IN (${PILOT_LOCK_ID}, ${SOURCE_LOCK_ID})`;
      const target = rows.find(r => r.ttlockLockId === PILOT_LOCK_ID);
      const source = rows.find(r => r.ttlockLockId === SOURCE_LOCK_ID);
      if (rows.length !== 2 || !target?.isActive || !source?.isActive || target.status !== 'ACTIVE'
          || target.propertyId !== DEMO_PROPERTY_ID || target.isTestProperty !== true
          || target.organizationId !== source.organizationId) fail('PILOT_SCOPE_MISMATCH');
      const [token] = await tx`SELECT "accessToken", "expiresAt" FROM "TTLockAuth"
        WHERE "organizationId" = ${target.organizationId}`;
      return token;
    });
  } finally { await sql.close(); }
  if (!auth?.accessToken || !(new Date(auth.expiresAt).getTime() > Date.now() + 300000)) fail('TTLOCK_AUTH_EXPIRING');
  const config = {base, clientId: env.TTLOCK_CLIENT_ID, accessToken: auth.accessToken};
  const sourceCards = await cardsFor(config, SOURCE_LOCK_ID);
  const before = await cardsFor(config, PILOT_LOCK_ID);
  const plan = planEnrollment(sourceCards, before, startDate, endDate);
  const common = {kind: 'NFC_PRIME_ENROLL', lockId: PILOT_LOCK_ID, sourceLockId: SOURCE_LOCK_ID,
    sourceCardId: SOURCE_CARD_ID, label: PILOT_LABEL, startDate, endDate,
    physicalCompatibility: 'NOT_TESTED', databaseWrites: 0};
  if (plan.state === 'ALREADY_PRESENT') {
    console.log(JSON.stringify({...common, status: 'ALREADY_PRESENT', cardId: plan.card.cardId, writes: 0}));
    return;
  }
  const linked = await providerRead(config, '/v3/gateway/listByLock', {lockId: String(PILOT_LOCK_ID)});
  const linkedIds = new Set((linked.list ?? []).map(g => String(g.gatewayId)));
  let online = false;
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const page = await providerRead(config, '/v3/gateway/list', {pageNo: String(pageNo), pageSize: '100'});
    if (!Array.isArray(page.list)) fail('INVALID_GATEWAY_LIST');
    online ||= page.list.some(g => linkedIds.has(String(g.gatewayId)) && Number(g.isOnline) === 1);
    if (page.list.length < 100) break;
  }
  if (!online) fail('PILOT_GATEWAY_OFFLINE');
  if (env.NFC_PRIME_EXECUTE !== 'ADD_DEMO_ONCE') {
    console.log(JSON.stringify({...common, status: 'READY_DRY_RUN', sourceLabel: plan.source.cardName,
      targetCardAbsent: true, gatewayOnline: true, writes: 0}));
    return;
  }
  // No automatic retry. Reconcile once after any ambiguous provider response.
  let cardId = null;
  let addError = null;
  try { cardId = await addPilot(config, plan.cardNumber, startDate, endDate); }
  catch (error) { addError = safeError(error); }
  let after;
  try { after = await cardsFor(config, PILOT_LOCK_ID); }
  catch {
    console.log(JSON.stringify({...common, status: 'RECONCILIATION_REQUIRED', cardId, addError, writeAttempts: 1}));
    process.exitCode = 1;
    return;
  }
  const added = after.filter(c => c.cardName === PILOT_LABEL
    && BigInt(numberOf(c)) === BigInt(plan.cardNumber)
    && Number(c.startDate) === startDate && Number(c.endDate) === endDate);
  const oldUnchanged = before.every(c => {
    const current = after.find(a => a.cardId === c.cardId);
    return current && JSON.stringify(publicCard(current)) === JSON.stringify(publicCard(c))
      && numberOf(current) === numberOf(c);
  });
  const verified = added.length === 1 && (!cardId || added[0].cardId === cardId)
    && oldUnchanged && after.length === before.length + 1;
  console.log(JSON.stringify({...common, status: verified ? 'PROVIDER_VERIFIED' : 'RECONCILIATION_REQUIRED',
    cardId: added[0]?.cardId ?? cardId, writeAttempts: 1, previousCardsUnchanged: oldUnchanged, addError}));
  if (!verified) process.exitCode = 1;
}

function safeError(error) {
  const message = String(error?.message ?? '');
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) || /^TTLOCK_CODE_-?\d+$/.test(message)
    ? message : 'PILOT_REQUEST_FAILED';
}

if (import.meta.main) {
  try { await runPilot(); }
  catch (error) {
    console.log(JSON.stringify({kind: 'NFC_PRIME_ENROLL', status: safeError(error), physicalCompatibility: 'NOT_TESTED'}));
    process.exitCode = 1;
  }
}
