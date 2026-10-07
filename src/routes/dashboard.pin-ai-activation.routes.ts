import { Router, type Request, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth, type AuthenticatedUser } from "../middleware/requireAuth.js";
import { createReviewRateLimit, reviewActorClientKey, requireTrustedReviewMutationOrigin } from "../services/reviews/review-route-security.js";
import { getPinAIProperty, setPinAIProperty, listPinAIOrganizations, setPinAIOrganization, getPinAIFeeOverview, PinAIActivationError } from "../services/pin-ai-activation.service.js";

import type { ConnectDebitProvider } from "../pin-ai/fee-connect.service.js";
import { createPinAIConnectStripeProvider } from "../pin-ai/fee-connect-stripe.provider.js";
import { pinAIAllOrganizationsAvailable } from "../pin-ai/fee-connect.service.js";

export function buildPinAIActivationRouter(db: PrismaClient, env: NodeJS.ProcessEnv = process.env,
  provider: Pick<ConnectDebitProvider, "eligibility"> = {
    eligibility: async accountId => {
      const { default: stripe } = await import("../billing/stripe.js");
      return createPinAIConnectStripeProvider(stripe).eligibility(accountId);
    },
  }) {
  const router = Router();
  const property = "/api/dashboard/properties/:propertyId/pin-ai-settings";
  const organizations = "/api/internal/pin-ai/organizations";
  const billing = "/api/dashboard/pin-ai/billing";
  const actor = (req: Request) => (req as Request & { user: AuthenticatedUser }).user;
  const wrap = (work: (req: Request) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json({ ok: true, ...await work(req) as object }); }
    catch (error) {
      const conflict = (error as { code?: string })?.code === "P2034";
      res.status(error instanceof PinAIActivationError ? error.status : conflict ? 409 : 503).json({ ok: false,
        error: error instanceof PinAIActivationError ? error.code : conflict ? "PIN_AI_ACTIVATION_CONFLICT" : "PIN_AI_ACTIVATION_UNAVAILABLE" });
    }
  };
  router.use([property, organizations, billing], (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, requireAuth,
    createReviewRateLimit({ namespace: "pin-ai-activation", max: 60, windowMs: 60_000, key: reviewActorClientKey }));
  router.get(property, wrap(req => getPinAIProperty(db, env, actor(req), String(req.params.propertyId))));
  router.get(billing, wrap(req => getPinAIFeeOverview(db, actor(req))));
  router.put(property, requireTrustedReviewMutationOrigin,
    wrap(req => setPinAIProperty(db, env, actor(req), String(req.params.propertyId), req.body, provider)));
  router.get(organizations, wrap(async req => ({ ...await listPinAIOrganizations(db, actor(req), req.query.q ?? ""),
    allOrganizationsAvailable: pinAIAllOrganizationsAvailable(env),
    rolloutActive: env.PIN_AI_PROPERTY_ACTIVATION_ENABLED === "true" })));
  router.put(`${organizations}/:organizationId`, requireTrustedReviewMutationOrigin,
    wrap(req => setPinAIOrganization(db, actor(req), String(req.params.organizationId), req.body)));
  return router;
}
