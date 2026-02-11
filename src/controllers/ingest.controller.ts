import type { Request, Response } from "express";
import { z } from "zod";
import { ingestReservation } from "../services/ingest.service";

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
});

export async function ingestReservationHandler(req: Request, res: Response) {
  const parsed = ingestReservationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid payload",
      details: parsed.error.flatten(),
    });
  }

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
