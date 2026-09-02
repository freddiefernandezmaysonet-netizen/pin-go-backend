import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getAuthCookieName, getBrandAuthCookieName } from "../../lib/auth.js";
import { hostnameFromSecureRequestOrigin } from "../branding/published-brand-origin.policy.js";
import { resolvePublishedBrandContextByHostname } from "../branding/published-brand-context.service.js";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type ReviewRateLimitOptions = {
  namespace: string;
  windowMs: number;
  max: number;
  key: (req: Request) => string;
};

type AuthenticatedReviewRequest = Request & {
  user?: {
    id?: string;
    orgId?: string;
  };
};

const RATE_LIMIT_BUCKET_CAP = 50_000;
const rateLimitBuckets = new Map<string, RateLimitBucket>();
let nextRateLimitPruneAt = 0;

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function pruneRateLimitBuckets(now: number): void {
  if (now >= nextRateLimitPruneAt) {
    nextRateLimitPruneAt = now + 60_000;
    for (const [key, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
  }

  while (rateLimitBuckets.size >= RATE_LIMIT_BUCKET_CAP) {
    const oldestKey = rateLimitBuckets.keys().next().value as string | undefined;
    if (!oldestKey) break;
    rateLimitBuckets.delete(oldestKey);
  }
}

function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetSeconds: number
): void {
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
}

/**
 * A bounded, process-local abuse fence for the review surface. It intentionally
 * avoids adding another runtime dependency; infrastructure-level distributed
 * limiting can still sit in front of the API when E1 is activated.
 */
export function createReviewRateLimit(
  options: ReviewRateLimitOptions
): RequestHandler {
  if (!options.namespace || options.windowMs < 1_000 || options.max < 1) {
    throw new Error("REVIEW_RATE_LIMIT_CONFIGURATION_INVALID");
  }

  return (req, res, next) => {
    const now = Date.now();
    const rawKey = String(options.key(req) || "unknown").slice(0, 1_024);
    const bucketKey = `${options.namespace}:${digest(rawKey)}`;
    let bucket = rateLimitBuckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket) pruneRateLimitBuckets(now);
      bucket = { count: 0, resetAt: now + options.windowMs };
      rateLimitBuckets.set(bucketKey, bucket);
    } else {
      // Refresh insertion order so capacity pressure evicts inactive clients first.
      rateLimitBuckets.delete(bucketKey);
      rateLimitBuckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    setRateLimitHeaders(res, options.max, options.max - bucket.count, resetSeconds);

    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({
        ok: false,
        error: "REVIEW_RATE_LIMITED",
        retryAfterSeconds: resetSeconds,
      });
      return;
    }

    next();
  };
}

export function reviewClientKey(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 128);
}

export function reviewTokenClientKey(req: Request): string {
  return `${reviewClientKey(req)}:${reviewTokenFromRequest(req).slice(0, 128)}`;
}

export function reviewTokenFromRequest(req: Request): string {
  const authorization = String(req.get("authorization") ?? "").trim();
  const match = authorization.match(/^ReviewToken\s+([A-Za-z0-9_-]{32,256})$/);
  return match?.[1] ?? "";
}

export function reviewPropertyClientKey(req: Request): string {
  return [
    reviewClientKey(req),
    String(req.params.organizationSlug ?? "").slice(0, 128),
    String(req.params.propertySlug ?? "").slice(0, 128),
  ].join(":");
}

export function reviewActorClientKey(req: Request): string {
  const actor = (req as AuthenticatedReviewRequest).user;
  return [
    reviewClientKey(req),
    String(actor?.orgId ?? "unknown-org").slice(0, 128),
    String(actor?.id ?? "unknown-actor").slice(0, 128),
  ].join(":");
}

function splitConfiguredOrigins(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function canonicalOrigin(value: string, allowReferrerPath = false): string | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const localDevelopment =
      process.env.NODE_ENV !== "production" &&
      parsed.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1");

    if (
      (parsed.protocol !== "https:" && !localDevelopment) ||
      parsed.username ||
      parsed.password ||
      (!allowReferrerPath && parsed.pathname !== "/") ||
      (!allowReferrerPath && (parsed.search || parsed.hash))
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredReviewOrigins(): Set<string> {
  const localDevelopmentOrigins = process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:5173", "http://localhost:4173"];
  const origins = [
    ...splitConfiguredOrigins(process.env.FRONTEND_ORIGIN),
    ...splitConfiguredOrigins(process.env.API_BASE_URL),
    ...splitConfiguredOrigins(process.env.PUBLIC_API_BASE_URL),
    ...localDevelopmentOrigins,
  ];

  return new Set(
    origins
      .map((origin) => canonicalOrigin(origin))
      .filter((origin): origin is string => Boolean(origin))
  );
}

function hasAuthCookie(req: Request): boolean {
  const acceptedNames = new Set([getAuthCookieName(), getBrandAuthCookieName()]);
  return String(req.get("cookie") ?? "")
    .split(";")
    .some((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && acceptedNames.has(part.slice(0, separator).trim());
    });
}

function mutationRequestOrigin(req: Request): string | null {
  const origin = String(req.get("origin") ?? "").trim();
  if (origin) return canonicalOrigin(origin);

  const referrer = String(req.get("referer") ?? "").trim();
  return referrer ? canonicalOrigin(referrer, true) : null;
}

/**
 * Cookie-authenticated review mutations require a trusted browser origin.
 * Requests without an auth cookie (including bearer-token and injected
 * server-side sessions) do not carry ambient browser authority. A request
 * that also carries a cookie never bypasses the origin check via a dummy
 * Authorization header.
 */
export async function requireTrustedReviewMutationOrigin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookieAuthenticated = hasAuthCookie(req);
  if (!cookieAuthenticated) {
    next();
    return;
  }

  const origin = mutationRequestOrigin(req);
  if (!origin) {
    res.status(403).json({ ok: false, error: "REVIEW_ORIGIN_REQUIRED" });
    return;
  }

  if (configuredReviewOrigins().has(origin)) {
    next();
    return;
  }

  try {
    const hostname = hostnameFromSecureRequestOrigin(origin);
    const context = hostname
      ? await resolvePublishedBrandContextByHostname(hostname)
      : null;
    const actor = (req as AuthenticatedReviewRequest).user;

    if (
      context?.kind === "CUSTOM_BRAND" &&
      context.customDomain === hostname &&
      context.organizationId === actor?.orgId
    ) {
      next();
      return;
    }
  } catch (error) {
    console.error("[REVIEW_ORIGIN_CHECK_FAILED]", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }

  res.status(403).json({ ok: false, error: "REVIEW_ORIGIN_NOT_ALLOWED" });
}
