import type { Request, Response } from "express";
import { z } from "zod";
import { ingestReservation } from "../services/ingest.service";
import { log } from "../utils/log";

const ingestReservationSchema = z.object({
  source: z.string().min(1).optional(),

  propertyId: z.string().min(1),
  guestName: z.string().min(1),
  guestEmail: z.string().email().optional().nullable(),
  guestPhone: z.string().min(5).optional().nullable(),
  roomName: z.string().min(1).optional().nullable(),

  checkIn: z.string().datetime(),
  checkOut: z.string().datetime(),

  paymentState: z.enum(["NONE", "PAID", "FAILED", "PENDING"]).optional(),

  // ✅ PMS FIELDS (estos son los que faltan en runtime)
  externalProvider: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  externalUpdatedAt: z.string().datetime().optional(),
  externalRaw: z.any().optional(),
  status: z.enum(["ACTIVE", "CANCELLED"]).optional(),
});

export async function ingestReservationHandler(req: Request, res: Response) {
  console.log("[INGEST CTRL] raw body keys", Object.keys(req.body || {}));

  console.log("[INGEST CTRL] raw external", {
    externalProvider: (req.body as any)?.externalProvider,
    externalId: (req.body as any)?.externalId,
  });

  log("ingest.request.received", {
    externalProvider: (req.body as any)?.externalProvider,
    externalId: (req.body as any)?.externalId,
  });

  const parsed = ingestReservationSchema.safeParse(req.body);

  if (!parsed.success) {
    console.log("[INGEST CTRL] parse failed", parsed.error.flatten());
    return res.status(400).json({
      ok: false,
      error: "Invalid payload",
      details: parsed.error.flatten(),
    });
  }

  console.log("[INGEST CTRL] parsed external", {
    externalProvider: (parsed.data as any)?.externalProvider,
    externalId: (parsed.data as any)?.externalId,
    externalUpdatedAt: (parsed.data as any)?.externalUpdatedAt,
    status: (parsed.data as any)?.status,
  });

  try {
    const result = await ingestReservation(parsed.data);
    return res.json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
    });
  }
}