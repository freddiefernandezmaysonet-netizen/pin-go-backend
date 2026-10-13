import assert from "node:assert/strict";
import test from "node:test";
import { createBudgetedLocalPlacesSearch } from "./local-places-budget.js";

const input = { query: "restaurants", latitude: 18.2, longitude: -66.3,
  radiusMeters: 5000, maxResults: 3, languageCode: "es" as const };
const env = { PIN_AI_RUNTIME_LOCAL_PLACES_ENABLED: "true", GOOGLE_MAPS_SERVER_API_KEY: "test-key" };
const answer = { provider: "GOOGLE_PLACES" as const, places: [] };

test("separate search instances share the monthly cap and provider failures retain their reservation", async () => {
  const counts = new Map<string, number>();
  const db = { $queryRaw: (async (_sql: TemplateStringsArray, month: string, limit: number) => {
    const count = counts.get(month) ?? 0;
    if (count >= limit) return [];
    counts.set(month, count + 1);
    return [{ attempts: count + 1 }];
  }) as any };
  let calls = 0;
  const provider = async () => { calls += 1; if (calls === 1) throw new Error("PROVIDER_FAILURE"); return answer; };
  let date = new Date("2026-10-31T23:59:59Z");
  const config = { ...env, PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT: "2" };
  const first = createBudgetedLocalPlacesSearch(db, config, provider, () => date);
  const restarted = createBudgetedLocalPlacesSearch(db, config, provider, () => date);
  await assert.rejects(first(input), /PROVIDER_FAILURE/);
  assert.deepEqual(await restarted(input), answer);
  await assert.rejects(first(input), /MONTHLY_LIMIT_REACHED/);
  assert.equal(calls, 2);
  assert.equal(counts.get("2026-10"), 2);
  date = new Date("2026-11-01T00:00:00Z");
  await restarted(input);
  assert.equal(counts.get("2026-11"), 1);
});

test("invalid configuration, absent credentials, exhausted quota and unavailable storage never call Google", async () => {
  let calls = 0;
  const provider = async () => { calls += 1; return answer; };
  const exhausted = { $queryRaw: (async () => []) as any };
  for (const [config, error] of [
    [{ ...env, PIN_AI_RUNTIME_LOCAL_PLACES_ENABLED: "false" }, /DISABLED/],
    [{ ...env, GOOGLE_MAPS_SERVER_API_KEY: "" }, /DISABLED/],
    [{ ...env, PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT: "0" }, /MONTHLY_LIMIT_REACHED/],
    [{ ...env, PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT: "1.5" }, /BUDGET_INVALID/],
    [{ ...env, PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT: "-1" }, /BUDGET_INVALID/],
    [{ ...env, PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT: "NaN" }, /BUDGET_INVALID/],
    [env, /MONTHLY_LIMIT_REACHED/],
  ] as const) await assert.rejects(createBudgetedLocalPlacesSearch(exhausted, config, provider)(input), error);
  await assert.rejects(createBudgetedLocalPlacesSearch({}, env, provider)(input), /BUDGET_UNAVAILABLE/);
  await assert.rejects(createBudgetedLocalPlacesSearch({ $queryRaw: (async () => { throw new Error("DB_DOWN"); }) as any },
    env, provider)(input), /BUDGET_UNAVAILABLE/);
  assert.equal(calls, 0);
});

test("default limit is 1000 and accounting stores only the month and counter", async () => {
  const db = { $queryRaw: (async (sql: TemplateStringsArray, ...values: unknown[]) => {
    assert.deepEqual(values, ["2026-10", 1000]);
    assert.match(sql.join("?"), /ON CONFLICT.*DO UPDATE/s);
    assert.match(sql.join("?"), /WHERE.*attempts.*</s);
    assert.doesNotMatch(sql.join("?"), /latitude|longitude|reservationId|query/);
    return [{ attempts: 1 }];
  }) as any };
  await createBudgetedLocalPlacesSearch(db, env, async (_input, options) => {
    assert.equal(options?.apiKey, "test-key"); return answer;
  }, () => new Date("2026-10-13T12:00:00Z"))(input);
});
