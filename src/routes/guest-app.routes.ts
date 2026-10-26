import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { guestAppVerificationChannel } from "../guest-mobile/guest-app-verification-channel.policy.js";
import { deliverGuestAppVerification } from "../guest-mobile/guest-app-verification-delivery.service.js";
import { GuestAppActivationError, activeAppStayWhere, requestOtaGuestAppActivation, verifyOtaGuestAppActivation } from "../guest-mobile/ota-guest-app-activation.service.js";

const STAY_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const COOKIE = "__Host-pingo-guest-activation";
const browserSecret = (req: Request) => String(req.headers.cookie ?? "").split(";")
  .map(part => part.trim()).find(part => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
const headers = (res: Response) => res.set({
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
});

function verificationPage(token: string, secret: string, es: boolean, challengeId?: string, notice?: string, channel: "CHANNEX" | "EMAIL" = "CHANNEX") {
  const destinationEs = channel === "EMAIL" ? "el email de tu reservación" : "la conversación de tu reservación en Airbnb o Booking.com";
  const destinationEn = channel === "EMAIL" ? "your reservation email" : "your booking conversation in Airbnb or Booking.com";
  return `<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pin&amp;Go Guest</title>
  <style>body{margin:0;background:#0b1220;color:#e7eefc;font:17px/1.5 system-ui,sans-serif}main{max-width:520px;margin:auto;padding:40px 24px}p{color:#c1cde1}button,input{box-sizing:border-box;width:100%;padding:16px;border-radius:12px;font:inherit;margin:12px 0}button{background:#2563eb;color:white;border:0;font-weight:700}a{color:#9ec5ff}input{border:1px solid #64748b}button:focus-visible,input:focus-visible{outline:3px solid #fbbf24}</style></head><body><main>
  <h1>${es ? "Vincula tu estadía" : "Link your stay"}</h1>
  <p>${challengeId ? (es ? `Enviamos un código de verificación a ${destinationEs}. Escríbelo aquí para autorizar este dispositivo.` : `We sent a verification code to ${destinationEn}. Enter it here to authorize this device.`) : (es ? `Para proteger tu acceso, confirma la vinculación con un código que recibirás en ${destinationEs}.` : `To protect your access, confirm linking with a code sent to ${destinationEn}.`)}</p>
  ${notice ? `<p role="alert">${notice}</p>` : ""}
  <form method="post" action="/guest/app/${token}/${challengeId ? "verify" : "request"}">
  <input type="hidden" name="csrf" value="${secret}">
  ${challengeId ? `<input type="hidden" name="challengeId" value="${challengeId}"><label for="code">${es ? "Código de verificación" : "Verification code"}</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>` : ""}
  <button type="submit">${challengeId ? (es ? "Confirmar dispositivo" : "Confirm device") : (es ? "Enviar código de verificación" : "Send verification code")}</button></form>
  <p>${es ? "El código vence en 10 minutos. No lo compartas. No es el código de la puerta. La app es opcional." : "The code expires in 10 minutes. Do not share it. This is not your door code. The app is optional."}</p>
  <a href="/guest/verify/${token}">${es ? "Continuar en el navegador" : "Continue in browser"}</a>
  </main></body></html>`;
}

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

function renderHandoff(token: string, preferredLanguage: string | null, browserToken = token) {
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
  ${browserToken !== token ? `<p>${es ? "Dispositivo confirmado. Este pase de activación vence en dos minutos y solo puede usarse una vez. Si vence, vuelve al enlace del mensaje para solicitar otra verificación." : "Device confirmed. This activation pass expires in two minutes and can only be used once. If it expires, return to your message link to request another verification."}</p>` : ""}
  <p>${es ? "Si la app no abre o no está instalada, continúa en el navegador. No necesitas recibir SMS. Si instalas la app, vuelve a abrir este mismo enlace para vincular tu reservación. Guarda este mensaje para volver a entrar." : "If the app does not open or is not installed, continue in your browser. You do not need to receive SMS. After installing the app, open this same link again to link your reservation. Keep this message to return to your stay."}</p>
  <a href="/guest/verify/${browserToken}">${es ? "Continuar en el navegador" : "Continue in browser"}</a>
  <p>${es ? "Abrir la app no libera el acceso a la propiedad. Los requisitos de registro y el horario de check-in siguen aplicando. No compartas este enlace privado." : "Opening the app does not release property access. Registration requirements and check-in times still apply. Do not share this private link."}</p>
</main></body></html>`;
}

export function buildGuestAppRouter(prisma: PrismaClient, options: {
  deliverVerification?: (input: { reservationId: string; challengeId: string; code: string }) => Promise<boolean>;
} = {}) {
  const router = Router();
  router.get("/guest/app/:token", async (req, res) => {
    headers(res);
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
        select: { preferredLanguage: true, source: true, externalProvider: true, externalId: true, guestEmail: true },
      });
      if (!reservation) return unavailable();
      const channel = guestAppVerificationChannel(reservation);
      if (!channel) return unavailable();
      {
        const secret = randomBytes(32).toString("base64url");
        res.cookie(COOKIE, secret, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 600_000 });
        return res.type("html").send(verificationPage(token, secret, /^es/i.test(reservation.preferredLanguage ?? ""), undefined, undefined, channel));
      }
    } catch {
      // Neither the URL nor exception text is logged: both may contain a bearer.
      return res.status(503).type("html").send(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Pin&amp;Go Guest</title><h1>Please try again / Intenta nuevamente</h1><p>We could not check this link. / No pudimos comprobar este enlace.</p></html>"
      );
    }
  });
  const deliver = options.deliverVerification ?? (input => deliverGuestAppVerification(prisma, input));
  for (const action of ["request", "verify"] as const) {
    router.post(`/guest/app/:token/${action}`, async (req, res) => {
      headers(res);
      const token = String(req.params.token ?? "");
      const secret = browserSecret(req);
      if (!STAY_TOKEN.test(token) || !/^[A-Za-z0-9_-]{43}$/.test(secret) || req.body?.csrf !== secret ||
          req.get("sec-fetch-site") === "cross-site") return res.status(403).type("html").send("Verification unavailable / Verificación no disponible");
      let es = false;
      let channel: "CHANNEX" | "EMAIL" = "EMAIL";
      try {
        const stay = await prisma.reservation.findFirst({ where: { guestToken: token, ...activeAppStayWhere(new Date()) },
          select: { preferredLanguage: true, source: true, externalProvider: true, externalId: true, guestEmail: true } });
        const destination = stay ? guestAppVerificationChannel(stay) : null;
        if (!stay || !destination) throw new GuestAppActivationError("UNAVAILABLE");
        channel = destination;
        es = /^es/i.test(stay.preferredLanguage ?? "");
        if (action === "request") {
          const result = await requestOtaGuestAppActivation(prisma, { guestToken: token, browserSecret: secret }, deliver);
          return res.type("html").send(verificationPage(token, secret, es, result.id, undefined, channel));
        }
        const activationToken = await verifyOtaGuestAppActivation(prisma, {
          guestToken: token, browserSecret: secret, challengeId: String(req.body?.challengeId ?? ""), code: String(req.body?.code ?? "").trim(),
        });
        return res.type("html").send(renderHandoff(activationToken, stay.preferredLanguage, token));
      } catch (error) {
        const code = error instanceof GuestAppActivationError ? error.code : "UNAVAILABLE";
        const notice = code === "RATE_LIMITED" ? (es ? "Espera antes de solicitar otro código. Máximo cinco solicitudes por hora." : "Wait before requesting another code. Maximum five requests per hour.")
          : code === "INVALID_CODE" ? (es ? "No pudimos verificar el código. Comprueba el código y su vigencia; tienes un máximo de cinco intentos." : "We could not verify the code. Check the code and its expiry; you have a maximum of five attempts.")
          : (es ? "No pudimos completar la verificación. Intenta más tarde o contacta a tu host." : "We could not complete verification. Try later or contact your host.");
        const challengeId = code === "INVALID_CODE" && /^[A-Za-z0-9_-]{32}$/.test(String(req.body?.challengeId ?? "")) ? req.body.challengeId as string : undefined;
        return res.status(code === "RATE_LIMITED" ? 429 : code === "INVALID_CODE" ? 400 : 503).type("html")
          .send(verificationPage(token, secret, es, challengeId, notice, channel));
      }
    });
  }
  return router;
}
