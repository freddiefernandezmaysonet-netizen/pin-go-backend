import { withdrawCleaning, CleaningReassignmentError } from "../services/cleaning-reassignment.service.js";
import { reportCleaningIssue, readCleaningIssues, CleaningWorkIssueError } from "../services/cleaning-work-issue.service.js";
import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth.js";
import { assertCleanerIdentity } from "../auth/cleaner-surface.policy.js";
import { parseStaffLanguage } from "../services/staff-language.service.js";
import { CleanerAccountError, requestCleanerAccount, loadCleanerActivation, activateCleanerAccount } from "../services/cleaner-account.service.js";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function page(body: string, language = "en") {
  return `<!doctype html><html lang="${language}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pin&amp;Go</title><style>body{font:18px system-ui;background:#f8fafc;color:#172033;margin:0}main{max-width:480px;margin:24px auto;padding:24px;background:white;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:14px;font:inherit;margin:10px 0}button,a{color:#2563eb}button{background:#2563eb;color:white;border:0;border-radius:8px}</style><main>${body}</main></html>`;
}
function dashboardLoginUrl() {
  const raw = process.env.DASHBOARD_URL ?? process.env.APP_URL ?? "https://app.pin-ngo.com";
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) throw new Error("DASHBOARD_URL_INVALID");
  return new URL("/login", url).toString();
}
function fail(res: any, error: unknown) {
  if (error instanceof CleanerAccountError) return res.status(error.status).json({ error: error.code });
  // Do not print activation URLs, tokens or passwords.
  return res.status(500).json({ error: "CLEANER_REQUEST_FAILED" });
}
function activationFailure(res: any, error: unknown) {
  const code = error instanceof CleanerAccountError ? error.code : "";
  const message = code === "ACTIVATION_EMAIL_MISMATCH" ? "Usa el email registrado por tu host. / Use the email registered by your host."
    : code === "PASSWORD_POLICY_REQUIRED" ? "Elige una contraseña de 12 a 128 caracteres con mayúscula, minúscula, número y símbolo, sin tu email o nombre. / Choose a 12–128 character password with uppercase, lowercase, number and symbol, without your email or name."
    : code === "EMAIL_ALREADY_REGISTERED" ? "Ese email ya tiene una cuenta. No se modificó. / That email already has an account. It was not changed."
    : code === "ACTIVATION_INVALID" ? "Este enlace de activación venció o dejó de estar disponible. / This activation link expired or is no longer available."
    : "No se pudo activar la cuenta. Inténtalo más tarde. / Could not activate the account. Try again later.";
  return res.status(error instanceof CleanerAccountError ? error.status : 500).send(page(`<h1>Pin&amp;Go</h1><p role="alert">${message}</p><a href="">Volver / Go back</a>`));
}

export function buildCleanerAccountRouter(prisma: PrismaClient, authenticate: RequestHandler = requireAuth) {
  const router = Router();
  router.post("/api/staff/:staffId/cleaner-account", authenticate, async (req: any, res) => {
    if (!["ADMIN", "ORG_ADMIN", "PLATFORM_ADMIN"].includes(req.user.role)) return res.status(403).json({ error: "HOST_ADMIN_REQUIRED" });
    try { return res.json(await requestCleanerAccount(prisma, req.user.orgId, String(req.params.staffId), req.body?.email)); }
    catch (error) { return fail(res, error); }
  });

  router.use("/api/cleaner", authenticate, async (req: any, res, next) => {
    try {
      const staff = await prisma.staffMember.findUnique({ where: { dashboardUserId: req.user.id } });
      assertCleanerIdentity(req.user, staff);
      res.locals.cleaner = staff;
      return next();
    } catch { return res.status(403).json({ error: "CLEANER_IDENTITY_REQUIRED" }); }
  });
  router.post("/api/cleaner/cleanings/:id/cancel", async (req, res) => {
    try {
      const staff = res.locals.cleaner;
      return res.json(await withdrawCleaning(prisma, { confirmationId: String(req.params.id), staffMemberId: staff.id, organizationId: staff.organizationId }, "cancel"));
    } catch (error) {
      if (error instanceof CleaningReassignmentError) return res.status(error.status).json({ error: error.code });
      return fail(res, error);
    }
  });
  router.route("/api/cleaner/cleanings/:id/issues")
    .get(async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const staff = res.locals.cleaner;
        return res.json(await readCleaningIssues(prisma, { confirmationId: String(req.params.id), staffMemberId: staff.id, organizationId: staff.organizationId }));
      } catch (error) {
        if (error instanceof CleaningWorkIssueError) return res.status(error.status).json({ error: error.code });
        return fail(res, error);
      }
    })
    .post(async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const staff = res.locals.cleaner;
        return res.json(await reportCleaningIssue(prisma, { confirmationId: String(req.params.id), staffMemberId: staff.id, organizationId: staff.organizationId }, req.body));
      } catch (error) {
        if (error instanceof CleaningWorkIssueError) return res.status(error.status).json({ error: error.code });
        return fail(res, error);
      }
    });
  router.get("/api/cleaner/me", (_req, res) => {
    const staff = res.locals.cleaner;
    res.setHeader("Cache-Control", "no-store");
    return res.json({ id: staff.id, fullName: staff.fullName, preferredLanguage: staff.preferredLanguage });
  });
  router.patch("/api/cleaner/me/language", async (req, res) => {
    try {
      const language = parseStaffLanguage(req.body?.language);
      const staff = await prisma.staffMember.update({ where: { id: res.locals.cleaner.id }, data: { preferredLanguage: language } });
      return res.json({ id: staff.id, fullName: staff.fullName, preferredLanguage: staff.preferredLanguage });
    } catch { return res.status(400).json({ error: "LANGUAGE_INVALID" }); }
  });
  router.get("/api/cleaner/cleanings", async (req, res) => {
    try {
      const staff = res.locals.cleaner;
      const limit = 25;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const view = req.query.view;
      if (view !== undefined && !["today", "upcoming", "history"].includes(String(view))) return res.status(400).json({ error: "CLEANING_VIEW_INVALID" });
      const ids = view === undefined ? null : await cleanerTaskPageIds(prisma, {
        staffMemberId: staff.id, organizationId: staff.organizationId, view: view as CleanerTaskView,
        cursor, now: new Date(), limit: limit + 1,
      });
      const offers = await prisma.cleaningConfirmation.findMany({
        where: { staffMemberId: staff.id, ...(ids ? { id: { in: ids } } : cursor ? { id: { lt: cursor } } : {}) },
        orderBy: { id: "desc" }, take: limit + 1,
      });
      const reservations = await prisma.reservation.findMany({ where: { id: { in: offers.map(o => o.reservationId) }, property: { organizationId: staff.organizationId } }, include: { property: { select: { id: true, name: true, timezone: true } } } });
      const works = await prisma.cleaningWork.findMany({ where: { staffMemberId: staff.id, confirmationId: { in: offers.map(o => o.id) }, propertyId: { in: reservations.map(r => r.propertyId) } } });
      const access = await prisma.staffAssignment.findMany({ where: { staffMemberId: staff.id, reservationId: { in: reservations.map(r => r.id) } }, select: { reservationId: true, startsAt: true, endsAt: true, status: true } });
      const items = offers.slice(0, limit).flatMap(offer => {
        const reservation = reservations.find(r => r.id === offer.reservationId && r.propertyId === offer.propertyId);
        if (!reservation) return [];
        const work = works.find(w => w.confirmationId === offer.id && w.reservationId === reservation.id);
        const status = reservation.status === "CANCELLED" ? "CANCELLED" : work?.completionConfirmedAt ? "COMPLETED" : work?.cancelledAt ? "CANCELLED" : work?.supersededAt ? "REASSIGNED" : work?.startConfirmedAt ? "IN_PROGRESS" : offer.status;
        return [{ id: offer.id, property: reservation.property, status, departureAt: reservation.checkOut,
          scheduledStartAt: work?.scheduledStartAt ?? null, durationCommitmentMinutes: work?.durationCommitmentMinutes ?? null,
          startedAt: work?.startConfirmedAt ?? null, completedAt: work?.completionConfirmedAt ?? null,
          access: access.find(a => a.reservationId === reservation.id) ?? null }];
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ items, nextCursor: offers.length > limit ? offers[limit - 1]!.id : null });
    } catch (error) { return fail(res, error); }
  });
  router.get("/api/cleaner/cleanings/:id", async (req, res) => {
    try {
      const staff = res.locals.cleaner;
      const offer = await prisma.cleaningConfirmation.findFirst({ where: { id: String(req.params.id), staffMemberId: staff.id, status: { in: ["PENDING", "CONFIRMED"] } } });
      const reservation = offer && await prisma.reservation.findFirst({ where: { id: offer.reservationId, propertyId: offer.propertyId, status: "ACTIVE", property: { organizationId: staff.organizationId } } });
      const closed = offer && await prisma.cleaningWork.findFirst({ where: { confirmationId: offer.id, staffMemberId: staff.id, OR: [{ cancelledAt: { not: null } }, { supersededAt: { not: null } }] } });
      if (!offer || !reservation || closed) return res.status(404).json({ error: "CLEANING_NOT_AVAILABLE" });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ id: offer.id, portalPath: `/cleaning/confirm/${encodeURIComponent(offer.token)}` });
    } catch (error) { return fail(res, error); }
  });

  router.get("/cleaning/account/activate/:token", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Keep same-origin form POSTs identifiable without leaking activation URLs to other sites.
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      const activation = await loadCleanerActivation(prisma, String(req.params.token));
      const es = activation.staffMember.preferredLanguage === "es";
      return res.send(page(`<h1>${es ? "Activar mi cuenta" : "Activate my account"}</h1><p>${es ? "Usa el email registrado por tu host y elige tu contraseña." : "Use the email registered by your host and choose your password."}</p><form method="POST"><label>Email<input name="email" type="email" required autocomplete="username"></label><label>${es ? "Contraseña" : "Password"}<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><p>${es ? "Mínimo 12 caracteres, mayúscula, minúscula, número y símbolo." : "At least 12 characters, uppercase, lowercase, number and symbol."}</p><button>${es ? "Activar cuenta" : "Activate account"}</button></form>`, es ? "es" : "en"));
    } catch (error) { return activationFailure(res, error); }
  });
  router.post("/cleaning/account/activate/:token", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Keep same-origin form POSTs identifiable without leaking activation URLs to other sites.
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      const activation = await loadCleanerActivation(prisma, String(req.params.token));
      const es = activation.staffMember.preferredLanguage === "es";
      const login = escapeHtml(dashboardLoginUrl());
      await activateCleanerAccount(prisma, String(req.params.token), req.body?.email, String(req.body?.password ?? ""));
      return res.send(page(`<h1>${es ? "Cuenta activada" : "Account activated"}</h1><a href="${login}">${es ? "Entrar a Mis limpiezas" : "Sign in to My cleanings"}</a>`, es ? "es" : "en"));
    } catch (error) { return activationFailure(res, error); }
  });
  return router;
}
import { cleanerTaskPageIds, type CleanerTaskView } from "../services/cleaner-task-pagination.service.js";
