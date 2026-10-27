// Read-only hardware discovery for the Prime NFC pilot. Run with Bun.
// No imports from the server, workers or reservation flows; no database writes.
export const DEMO_PROPERTY_ID = "cmomyua8b0001rv1dvl6xjr6g";
const READ_PATHS = new Set([
  "/v3/identityCard/list",
  "/v3/gateway/listByLock",
  "/v3/gateway/list",
  "/v3/lock/detail",
]);
let phase = "configuration";

export function checkedBase(value = "https://api.sciener.com") {
  const url = new URL(value);
  if (url.origin !== "https://api.sciener.com" || !["", "/"].includes(url.pathname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("UNSUPPORTED_TTLOCK_ORIGIN");
  }
  return url.origin;
}

export async function providerRead(config, path, fields, fetcher = fetch) {
  if (!READ_PATHS.has(path)) throw new Error("READ_ONLY_ENDPOINT_REQUIRED");
  const base = checkedBase(config.base);
  if (!config.clientId || !config.accessToken) throw new Error("TTLOCK_AUTH_MISSING");
  const body = new URLSearchParams({ ...fields, clientId: config.clientId,
    accessToken: config.accessToken, date: String(Date.now()) });
  const response = await fetcher(`${base}${path}`, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TTLOCK_HTTP_${response.status}`);
  let data;
  try { data = await response.json(); }
  catch { throw new Error("TTLOCK_INVALID_JSON"); }
  if (data?.errcode != null && Number(data.errcode) !== 0) {
    const code = Number(data.errcode);
    throw new Error(`TTLOCK_CODE_${Number.isFinite(code) ? code : "UNKNOWN"}`);
  }
  return data;
}

export function publicCard(card) {
  // Physical card numbers, tokens and lockData never enter the report.
  return { cardId: card.cardId, label: card.cardName ?? null,
    startDate: card.startDate ?? null, endDate: card.endDate ?? null };
}

export function referenceMatches(card, reference) {
  // Compare decimal representations only; never infer hex or reverse UID bytes.
  const decimal = value => /^\d{1,20}$/.test(String(value ?? "")) ? BigInt(value).toString() : null;
  const target = decimal(reference);
  if (target === null) throw new Error("INVALID_CARD_REFERENCE");
  return ["cardId", "cardNumber"].filter(field => decimal(card[field]) === target);
}

export async function main(env = process.env) {
  if (env.NFC_PRIME_PREFLIGHT !== "1" || !env.DATABASE_URL || !env.TTLOCK_CLIENT_ID) {
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "NOT_CONFIGURED", writes: 0 }));
    return;
  }
  const base = checkedBase(env.TTLOCK_API_BASE);
  const reference = env.NFC_PRIME_CARD_REFERENCE;
  if (reference !== undefined) referenceMatches({}, reference);
  phase = "database_connection";
  const { SQL } = await import("bun");
  const databaseUrl = new URL(env.DATABASE_URL);
  // Prisma's schema option is not a PostgreSQL startup parameter.
  const schema = databaseUrl.searchParams.get("schema");
  if (schema && schema !== "public") throw new Error("UNSUPPORTED_DATABASE_SCHEMA");
  databaseUrl.searchParams.delete("schema");
  const sql = new SQL(databaseUrl.toString(), { max: 1, connectionTimeout: 10, idleTimeout: 5 });
  let snapshot;
  try {
    snapshot = await sql.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '10000ms'`;
      phase = "demo_property";
      const [property] = await tx`
        SELECT id, name, "organizationId", "isTestProperty", status, timezone
        FROM "Property" WHERE id = ${DEMO_PROPERTY_ID}`;
      if (!property || property.status !== "ACTIVE") throw new Error("DEMO_NOT_ACTIVE");
      phase = "demo_locks";
      const locks = await tx`
        SELECT l.id, l."ttlockLockId", l."displayName", l."ttlockLockName", l."isActive",
          g."ttlockGatewayId", g."isOnline" AS "gatewayOnlineCached", g."lastEventAt"
        FROM "Lock" l LEFT JOIN "TtlockGateway" g ON g.id = l."ttlockGatewayRecordId"
        WHERE l."propertyId" = ${DEMO_PROPERTY_ID} AND l."isActive" = true
        ORDER BY l."ttlockLockId" LIMIT 10`;
      phase = "organization_auth";
      const [auth] = await tx`
        SELECT "accessToken", "expiresAt" FROM "TTLockAuth"
        WHERE "organizationId" = ${property.organizationId}`;
      phase = "reservation_count";
      const [reservations] = await tx`
        SELECT count(*)::int AS "activeReservationsNext24h" FROM "Reservation"
        WHERE "propertyId" = ${DEMO_PROPERTY_ID} AND status = 'ACTIVE'
          AND "checkOut" > CURRENT_TIMESTAMP AND "checkIn" < CURRENT_TIMESTAMP + INTERVAL '24 hours'`;
      const lookupLocks = reference === undefined ? [] : await tx`
        SELECT l."ttlockLockId", l."ttlockLockName", p.name AS "propertyName", p.id AS "propertyId"
        FROM "Lock" l JOIN "Property" p ON p.id = l."propertyId"
        WHERE p."organizationId" = ${property.organizationId} AND l."isActive" = true
        ORDER BY l."ttlockLockId" LIMIT 51`;
      return { property, locks, auth, reservations, lookupLocks };
    });
  } finally { await sql.close(); }
  const { property, locks, auth, reservations, lookupLocks } = snapshot;
  console.log(JSON.stringify({ kind: "NFC_PRIME_SCOPE", writes: 0,
    property: { id: property.id, name: property.name, isTestProperty: property.isTestProperty,
      timezone: property.timezone }, ...reservations, locks }));
  if (!auth?.accessToken || !(new Date(auth.expiresAt).getTime() > Date.now() + 300_000)) {
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "ORG_TOKEN_UNAVAILABLE_OR_EXPIRING", writes: 0 }));
    return;
  }
  const config = { base, clientId: env.TTLOCK_CLIENT_ID, accessToken: auth.accessToken };
  phase = "ttlock_reads";
  if (reference !== undefined) {
    if (lookupLocks.length > 50) throw new Error("CARD_LOOKUP_SCOPE_TOO_LARGE");
    const matches = [];
    let complete = true;
    for (const lock of lookupLocks) {
      let lockComplete = false;
      for (let pageNo = 1; pageNo <= 10; pageNo++) {
        const page = await providerRead(config, "/v3/identityCard/list", {
          lockId: String(lock.ttlockLockId), pageNo: String(pageNo), pageSize: "100",
        });
        if (!Array.isArray(page.list)) throw new Error("INVALID_CARD_LIST");
        for (const card of page.list) {
          const matchedFields = referenceMatches(card, reference);
          if (matchedFields.length) matches.push({ ...lock, ...publicCard(card), matchedFields });
        }
        if (page.list.length < 100) { lockComplete = true; break; }
      }
      complete = complete && lockComplete;
    }
    console.log(JSON.stringify({ kind: "NFC_PRIME_CARD_LOOKUP", writes: 0,
      status: complete ? "READ_COMPLETE" : "PARTIAL_READ", scope: "DEMO_ORGANIZATION_ACTIVE_LOCKS",
      locksChecked: lookupLocks.length, matches, physicalCompatibility: "NOT_TESTED" }));
    return;
  }
  const gatewayStates = new Map();
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const page = await providerRead(config, "/v3/gateway/list", {
      pageNo: String(pageNo), pageSize: "100",
    });
    if (!Array.isArray(page.list)) throw new Error("INVALID_GATEWAY_LIST");
    for (const gateway of page.list) gatewayStates.set(String(gateway.gatewayId), gateway.isOnline);
    if (page.list.length < 100) break;
  }
  for (const lock of locks) {
    const lockId = String(lock.ttlockLockId);
    const detail = await providerRead(config, "/v3/lock/detail", { lockId });
    const gateways = await providerRead(config, "/v3/gateway/listByLock", { lockId });
    const cards = [];
    let complete = false;
    for (let pageNo = 1; pageNo <= 10; pageNo++) {
      const page = await providerRead(config, "/v3/identityCard/list", {
        lockId, pageNo: String(pageNo), pageSize: "100",
      });
      if (!Array.isArray(page.list)) throw new Error("INVALID_CARD_LIST");
      cards.push(...page.list.map(publicCard));
      if (page.list.length < 100) { complete = true; break; }
    }
    const gatewayList = Array.isArray(gateways.list) ? gateways.list :
      Array.isArray(gateways) ? gateways : [];
    console.log(JSON.stringify({ kind: "NFC_PRIME_LOCK", writes: 0, lockId: lock.ttlockLockId,
      batteryPercent: detail.electricQuantity ?? null, featureValue: detail.featureValue ?? null,
      gatewayIdFromDetail: detail.gatewayId ?? null,
      gateways: gatewayList.map(g => ({ gatewayId: g.gatewayId, name: g.gatewayName ?? null,
        isOnline: gatewayStates.get(String(g.gatewayId)) ?? null, rssi: g.rssi ?? null })),
      cardListComplete: complete, cardCount: cards.length, cards }));
  }
  console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "READ_COMPLETE",
    physicalCompatibility: "NOT_TESTED", writes: 0 }));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const message = String(error?.message ?? "");
    const safe = /^(INVALID_CARD_REFERENCE|CARD_LOOKUP_SCOPE_TOO_LARGE|UNSUPPORTED_DATABASE_SCHEMA|UNSUPPORTED_TTLOCK_ORIGIN|READ_ONLY_ENDPOINT_REQUIRED|TTLOCK_AUTH_MISSING|TTLOCK_HTTP_\d+|TTLOCK_INVALID_JSON|TTLOCK_CODE_-?\d+|INVALID_CARD_LIST|INVALID_GATEWAY_LIST|DEMO_NOT_ACTIVE)$/.test(message)
      ? message : "PREFLIGHT_FAILED";
    const sqlState = /^[A-Z0-9_]{2,60}$/.test(String(error?.code ?? "")) ? error.code : null;
    const missingColumn = message.match(/^column "([A-Za-z0-9_.]+)" does not exist$/)?.[1] ?? null;
    const dbErrorHint = ["unrecognized configuration parameter", "password authentication failed",
      "permission denied", "read-only transaction", "syntax error", "does not exist",
      "cannot set transaction", "timeout"].find(hint => message.toLowerCase().includes(hint)) ?? null;
    const serverCode = /^[A-Z0-9]{5}$/.test(String(error?.errno ?? "")) ? error.errno : null;
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: safe, phase,
      sqlState, serverCode, dbErrorHint, missingColumn,
      errorType: error?.name === "TypeError" ? "TypeError" : "Error", writes: 0 }));
    process.exitCode = 1;
  }
}
