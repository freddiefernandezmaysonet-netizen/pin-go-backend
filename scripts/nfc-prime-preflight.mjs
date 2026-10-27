// Read-only hardware discovery for the Prime NFC pilot. Run with Bun.
// No imports from the server, workers or reservation flows; no database writes.
export const DEMO_PROPERTY_ID = "cmomyua8b0001rv1dvl6xjr6g";
const READ_PATHS = new Set([
  "/v3/identityCard/list",
  "/v3/gateway/listByLock",
  "/v3/lock/detail",
]);

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

export async function main(env = process.env) {
  if (env.NFC_PRIME_PREFLIGHT !== "1" || !env.DATABASE_URL || !env.TTLOCK_CLIENT_ID) {
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "NOT_CONFIGURED", writes: 0 }));
    return;
  }
  const base = checkedBase(env.TTLOCK_API_BASE);
  const { SQL } = await import("bun");
  const sql = new SQL(env.DATABASE_URL, { max: 1, connectionTimeout: 10, idleTimeout: 5 });
  let snapshot;
  try {
    snapshot = await sql.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '10000ms'`;
      const [property] = await tx`
        SELECT id, name, "organizationId", "isTestProperty", status, timezone
        FROM "Property" WHERE id = ${DEMO_PROPERTY_ID}`;
      if (!property || property.status !== "ACTIVE") throw new Error("DEMO_NOT_ACTIVE");
      const locks = await tx`
        SELECT l.id, l."ttlockLockId", l."displayName", l."ttlockLockName", l."isActive",
          g."ttlockGatewayId", g."isOnline" AS "gatewayOnlineCached", g."lastEventAt"
        FROM "Lock" l LEFT JOIN "TtlockGateway" g ON g.id = l."ttlockGatewayRecordId"
        WHERE l."propertyId" = ${DEMO_PROPERTY_ID} AND l."isActive" = true
        ORDER BY l."ttlockLockId" LIMIT 10`;
      const [auth] = await tx`
        SELECT "accessToken", "expiresAt" FROM "TTLockAuth"
        WHERE "organizationId" = ${property.organizationId}`;
      const [reservations] = await tx`
        SELECT count(*)::int AS "activeReservationsNext24h" FROM "Reservation"
        WHERE "propertyId" = ${DEMO_PROPERTY_ID} AND status = 'ACTIVE'
          AND "checkOut" > CURRENT_TIMESTAMP AND "checkIn" < CURRENT_TIMESTAMP + INTERVAL '24 hours'`;
      return { property, locks, auth, reservations };
    });
  } finally { await sql.close(); }
  const { property, locks, auth, reservations } = snapshot;
  console.log(JSON.stringify({ kind: "NFC_PRIME_SCOPE", writes: 0,
    property: { id: property.id, name: property.name, isTestProperty: property.isTestProperty,
      timezone: property.timezone }, ...reservations, locks }));
  if (!auth?.accessToken || !(new Date(auth.expiresAt).getTime() > Date.now() + 300_000)) {
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "ORG_TOKEN_UNAVAILABLE_OR_EXPIRING", writes: 0 }));
    return;
  }
  const config = { base, clientId: env.TTLOCK_CLIENT_ID, accessToken: auth.accessToken };
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
        isOnline: g.isOnline ?? null, rssi: g.rssi ?? null })),
      cardListComplete: complete, cardCount: cards.length, cards }));
  }
  console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: "READ_COMPLETE",
    physicalCompatibility: "NOT_TESTED", writes: 0 }));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const message = String(error?.message ?? "");
    const safe = /^(UNSUPPORTED_TTLOCK_ORIGIN|READ_ONLY_ENDPOINT_REQUIRED|TTLOCK_AUTH_MISSING|TTLOCK_HTTP_\d+|TTLOCK_INVALID_JSON|TTLOCK_CODE_-?\d+|INVALID_CARD_LIST|DEMO_NOT_ACTIVE)$/.test(message)
      ? message : "PREFLIGHT_FAILED";
    console.log(JSON.stringify({ kind: "NFC_PRIME_PREFLIGHT", status: safe, writes: 0 }));
    process.exitCode = 1;
  }
}
