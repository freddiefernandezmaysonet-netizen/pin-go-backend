import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

const STAY_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

// HTTPS entry point for email/browser users. Opening the native app is always
// an explicit action; the web portal remains usable without an app or SMS.
export function renderGuestAppEntry(token: string, preferredLanguage?: string | null) {
  if (!STAY_TOKEN.test(token)) return "";
  const es = /^es(?:-|$)/i.test(preferredLanguage ?? "");
  return `<div class="card">
    <p><a class="link" href="/guest/app/${token}">${es ? "Usar Pin&amp;Go Guest" : "Use Pin&amp;Go Guest"}</a></p>
    <p class="muted small">${es ? "La app es opcional. También puedes continuar en el navegador, sin recibir SMS." : "The app is optional. You can also continue in your browser without receiving SMS."}</p>
  </div>`;
}

function renderHandoff(token: string, preferredLanguage: string | null) {
  const es = /^es(?:-|$)/i.test(preferredLanguage ?? "");
  return `<!doctype html>
<html lang="${es ? "es" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Pin&amp;Go Guest</title>
  <style>
    body{margin:0;background:#0b1220;color:#e7eefc;font:17px/1.5 system-ui,sans-serif}
    main{max-width:520px;margin:0 auto;padding:40px 24px}
    h1{font-size:28px;line-height:1.2} p{color:#c1cde1}
    a{display:block;padding:14px 18px;margin:16px 0;border-radius:12px;text-align:center;font-weight:700;color:white;border:1px solid #64748b;text-decoration:none}
    .primary{background:#2563eb;border-color:#2563eb} a:focus-visible{outline:3px solid #fbbf24;outline-offset:3px}
  </style>
</head>
<body><main>
  <h1>${es ? "Tu estancia en Pin&amp;Go Guest" : "Your stay in Pin&amp;Go Guest"}</h1>
  <p>${es ? "Si tienes la app instalada en este dispositivo, abre tu reserva con este botón." : "If the app is installed on this device, open your reservation using this button."}</p>
  <a class="primary" href="pingo-guest://stay/${token}">${es ? "Abrir en Pin&amp;Go Guest" : "Open in Pin&amp;Go Guest"}</a>
  <p>${es ? "Si la app no abre o no está instalada, continúa en el navegador. No necesitas recibir SMS. Si instalas la app, vuelve a abrir este mismo enlace para vincular tu reservación. Guarda este mensaje para volver a entrar." : "If the app does not open or is not installed, continue in your browser. You do not need to receive SMS. After installing the app, open this same link again to link your reservation. Keep this message to return to your stay."}</p>
  <a href="/guest/verify/${token}">${es ? "Continuar en el navegador" : "Continue in browser"}</a>
  <p>${es ? "Abrir la app no libera el acceso a la propiedad. Los requisitos de registro y el horario de check-in siguen aplicando. No compartas este enlace privado." : "Opening the app does not release property access. Registration requirements and check-in times still apply. Do not share this private link."}</p>
</main></body></html>`;
}

export function buildGuestAppRouter(prisma: Pick<PrismaClient, "reservation">) {
  const router = Router();
  router.get("/guest/app/:token", async (req, res) => {
    res.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    const unavailable = () => res.status(404).type("html").send(
      "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Pin&amp;Go Guest</title><h1>Link unavailable / Enlace no disponible</h1><p>Use your latest private stay link or contact your host. / Usa tu enlace privado más reciente o contacta al host.</p></html>"
    );
    const token = req.params.token ?? "";
    if (!STAY_TOKEN.test(token)) return unavailable();
    try {
      const now = new Date();
      const reservation = await prisma.reservation.findFirst({
        where: {
          guestToken: token,
          guestTokenExpiresAt: { gt: now },
          status: "ACTIVE",
          checkOut: { gt: now },
          property: { status: "ACTIVE" },
          OR: [{ guestStayLink: null }, { guestStayLink: { revokedAt: null } }],
        },
        select: { preferredLanguage: true },
      });
      if (!reservation) return unavailable();
      return res.type("html").send(renderHandoff(token, reservation.preferredLanguage));
    } catch {
      // Neither the URL nor exception text is logged: both may contain a bearer.
      return res.status(503).type("html").send(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Pin&amp;Go Guest</title><h1>Please try again / Intenta nuevamente</h1><p>We could not check this link. / No pudimos comprobar este enlace.</p></html>"
      );
    }
  });
  return router;
}
