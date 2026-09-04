import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { searchPublicStays } from "./services/public-stay-search.service";

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);
const STAGING_REVISION = "booking-search-staging-v1";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}

app.use(cors({ origin: true, credentials: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION });
});

app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION });
  } catch (error) {
    console.error("[booking-search-staging ready error]", error);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/public-booking/search", async (req, res) => {
  try {
    const result = await searchPublicStays({
      destination: String(req.query.destination ?? ""),
      checkIn: String(req.query.checkIn ?? ""),
      checkOut: String(req.query.checkOut ?? ""),
      guests: Number(req.query.guests),
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.code });
    }

    return res.json({ ...result, revision: STAGING_REVISION });
  } catch (error) {
    console.error("[booking-search-staging search error]", error);
    return res.status(500).json({
      ok: false,
      error: "PUBLIC_STAY_SEARCH_FAILED",
    });
  }
});

app.listen(PORT, () => {
  console.log(`[booking-search-staging] listening on ${PORT} revision=${STAGING_REVISION}`);
});
