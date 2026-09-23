import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  DamagePaymentAuthorizationError,
  getDamagePaymentAuthorizationTerms,
  recordDamagePaymentAuthorization,
} from "../services/damage-case-payment-authorization.service.js";

export function damagePaymentAuthorizationRouter(prisma: PrismaClient) {
  const router = Router();
  const path = "/manage/:guestToken/property-protection-case/payment-authorization";
  router.route(path)
    .all((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    })
    .get(async (req, res) => {
      try {
        return res.json(await getDamagePaymentAuthorizationTerms({ prisma, guestToken: req.params.guestToken, language: req.query.language }));
      } catch (error) { return respondError(res, error); }
    })
    .post(async (req, res) => {
      try {
        return res.json(await recordDamagePaymentAuthorization({ prisma, guestToken: req.params.guestToken, body: req.body }));
      } catch (error) { return respondError(res, error); }
    });
  return router;
}
function respondError(res: import("express").Response, error: unknown) {
  if (error instanceof DamagePaymentAuthorizationError)
    return res.status(error.statusCode).json({ ok: false, error: error.code });
  // Never log bearer tokens, consent bodies, SQL or payment method identifiers.
  return res.status(500).json({ ok: false, error: "PAYMENT_AUTHORIZATION_UNAVAILABLE" });
}
