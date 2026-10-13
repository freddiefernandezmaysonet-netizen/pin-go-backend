import type { PrismaClient } from "@prisma/client";
import { searchGooglePlaces, type GooglePlacesSearchInput, type GooglePlacesSearchResult } from "./google-places-read-client.js";

export class LocalPlacesBudgetError extends Error {
  constructor(readonly code: "LOCAL_PLACES_DISABLED" | "LOCAL_PLACES_BUDGET_INVALID" |
    "LOCAL_PLACES_BUDGET_UNAVAILABLE" | "LOCAL_PLACES_MONTHLY_LIMIT_REACHED") {
    super(code);
    this.name = "LocalPlacesBudgetError";
  }
}

// Attempts are reserved before the external request and retained on failure.
// One global UTC-month bucket is shared by every process and property.
export function createBudgetedLocalPlacesSearch(
  db: Partial<Pick<PrismaClient, "$queryRaw">>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  provider: typeof searchGooglePlaces = searchGooglePlaces,
  now: () => Date = () => new Date(),
): (input: GooglePlacesSearchInput) => Promise<GooglePlacesSearchResult> {
  return async input => {
    const apiKey = env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
    if (env.PIN_AI_RUNTIME_LOCAL_PLACES_ENABLED !== "true" || !apiKey) {
      throw new LocalPlacesBudgetError("LOCAL_PLACES_DISABLED");
    }
    const configured = env.PIN_AI_LOCAL_PLACES_MONTHLY_LIMIT ?? "1000";
    if (!/^\d+$/.test(configured)) throw new LocalPlacesBudgetError("LOCAL_PLACES_BUDGET_INVALID");
    const limit = Number(configured);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000_000) {
      throw new LocalPlacesBudgetError("LOCAL_PLACES_BUDGET_INVALID");
    }
    if (limit === 0) throw new LocalPlacesBudgetError("LOCAL_PLACES_MONTHLY_LIMIT_REACHED");
    const monthKey = now().toISOString().slice(0, 7);
    let reserved: { attempts: number }[];
    try {
      if (!db.$queryRaw) throw new LocalPlacesBudgetError("LOCAL_PLACES_BUDGET_UNAVAILABLE");
      reserved = await db.$queryRaw<{ attempts: number }[]>`
        INSERT INTO "PinAILocalPlacesUsageBucket" ("monthKey", "attempts", "updatedAt")
        VALUES (${monthKey}, 1, NOW())
        ON CONFLICT ("monthKey") DO UPDATE
          SET "attempts" = "PinAILocalPlacesUsageBucket"."attempts" + 1, "updatedAt" = NOW()
          WHERE "PinAILocalPlacesUsageBucket"."attempts" < ${limit}
        RETURNING "attempts"
      `;
    } catch {
      throw new LocalPlacesBudgetError("LOCAL_PLACES_BUDGET_UNAVAILABLE");
    }
    if (reserved.length === 0) throw new LocalPlacesBudgetError("LOCAL_PLACES_MONTHLY_LIMIT_REACHED");
    return provider(input, { apiKey });
  };
}
