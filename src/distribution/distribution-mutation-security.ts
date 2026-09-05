import type { NextFunction, Request, RequestHandler, Response } from "express";

export type DistributionMutationActor = {
  id?: string;
  orgId?: string;
  role?: string;
};

export type DistributionMutationRequest = Request & {
  user?: DistributionMutationActor;
  distributionRequestKey?: string;
};

const MUTATION_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function distributionMutationRequestKey(req: Request): string | null {
  const value = String(req.get("idempotency-key") ?? "").trim();
  return REQUEST_KEY_PATTERN.test(value) ? value : null;
}

export function createDistributionMutationSecurity(args: {
  isTrustedOrigin(origin: string, organizationId: string): Promise<boolean>;
}): RequestHandler {
  return async (req: DistributionMutationRequest, res: Response, next: NextFunction) => {
    const actor = req.user;
    if (!actor?.id || !actor.orgId || !MUTATION_ROLES.has(String(actor.role ?? ""))) {
      res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      return;
    }

    const rawOrigin = String(req.get("origin") ?? "").trim();
    const origin = rawOrigin ? canonicalOrigin(rawOrigin) : null;
    if (!origin) {
      res.status(403).json({ ok: false, error: "OTA_CONNECTION_ORIGIN_REQUIRED" });
      return;
    }

    let trusted = false;
    try {
      trusted = await args.isTrustedOrigin(origin, actor.orgId);
    } catch {
      trusted = false;
    }
    if (!trusted) {
      res.status(403).json({ ok: false, error: "OTA_CONNECTION_ORIGIN_NOT_ALLOWED" });
      return;
    }

    const requestKey = distributionMutationRequestKey(req);
    if (!requestKey) {
      res.status(400).json({ ok: false, error: "OTA_CONNECTION_IDEMPOTENCY_KEY_INVALID" });
      return;
    }
    req.distributionRequestKey = requestKey;
    next();
  };
}
