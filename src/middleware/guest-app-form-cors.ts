import type { RequestHandler } from "express";

/**
 * HTML form navigation is not a cross-origin API call. A privacy-preserving
 * no-referrer page can submit Origin: null; the general CORS allowlist rejects
 * that before the activation router can validate its cookie and CSRF secret.
 * Only the two exact URL-encoded activation forms use their route's own guards.
 * JSON clients, preflights and every other route retain normal CORS handling.
 */
export function withGuestAppFormCors(corsMiddleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const form = req.method === "POST" &&
      /^\/guest\/app\/[A-Za-z0-9_-]{16,200}\/(request|verify)$/.test(req.path) &&
      req.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
    if (form) return next();
    return corsMiddleware(req, res, next);
  };
}
