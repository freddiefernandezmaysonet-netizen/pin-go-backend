import { Router } from "express";
import { PrismaClient, AccessGrantType, AccessStatus } from "@prisma/client";

/* =====================
   Utils
===================== */
function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtLocal(d: Date) {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function autoRefreshScript(enabled: boolean) {
  if (!enabled) return "";

  return `
<script>
(function () {
  var seconds = 10;
  var triesLeft = 12; // 12 * 10s = 120s
  var el = document.getElementById("autorefresh");

  function tick() {
    if (!el) return;
    el.textContent = "Actualizando en " + seconds + "s… (" + triesLeft + " intentos)";
    seconds--;

    if (seconds < 0) {
      triesLeft--;
      if (triesLeft <= 0) {
        el.textContent = "Auto-actualización detenida. Si no se activa, contacta al host.";
        return;
      }
      location.reload();
    } else {
      setTimeout(tick, 1000);
    }
  }

  tick();
})();
</script>`;
}

/* =====================
   Router
===================== */
export function buildGuestRouter(prisma: PrismaClient) {
  const router = Router();

  // ✅ Canonical: /guest/:token
  router.get("/guest/:token", async (req, res) => {
    try {
      const token = String(req.params.token ?? "").trim();
      const now = new Date();

      if (!token) {
        return res.status(400).type("html").send(
          renderPage({
            title: "Pin&Go • Acceso",
            badge: { text: "⚠️ Token requerido", tone: "bad" },
            body: `<p class="muted">Falta el token de acceso.</p>`,
          })
        );
      }

      const reservation = await prisma.reservation.findFirst({
        where: {
          guestToken: token,
          guestTokenExpiresAt: { gt: now },
        },
        include: {
          property: true,
          accessGrants: {
            where: { type: AccessGrantType.GUEST },
            orderBy: { startsAt: "asc" },
            include: { lock: true },
          },
        },
      });

      // Token inválido o expirado
      if (!reservation) {
        return res.status(404).type("html").send(
          renderPage({
            title: "Pin&Go • Acceso",
            badge: { text: "⛔ No disponible", tone: "bad" },
            body: `
              <h1>Link inválido o expirado</h1>
              <p class="muted">Este enlace no es válido o ya expiró.</p>
              <p class="muted">Si necesitas ayuda, contacta al host.</p>
            `,
          })
        );
      }

      const grants = reservation.accessGrants ?? [];
      const active = grants.find((g) => g.status === AccessStatus.ACTIVE) ?? null;
      const pending = grants.find((g) => g.status === AccessStatus.PENDING) ?? null;
      const revoked = grants.find((g) => g.status === AccessStatus.REVOKED) ?? null;

      const checkIn = reservation.checkIn;
      const checkOut = reservation.checkOut;

      // ✅ Auto-refresh SOLO cuando:
      // - existe grant PENDING
      // - ya estamos dentro de la ventana
      // - no ha pasado el checkout
      const shouldAutoRefresh = !!pending && now >= pending.startsAt && now < checkOut;

      const lockName =
        active?.lock?.ttlockLockName ??
        pending?.lock?.ttlockLockName ??
        revoked?.lock?.ttlockLockName ??
        "Puerta";

      let badge: { text: string; tone: "good" | "warn" | "bad" } = {
        text: "⏳ Preparando",
        tone: "warn",
      };
      let headline = "Tu acceso se está preparando";
      let bodyHtml = "";

      // ⛔ Expirado (por fecha)
      if (now >= checkOut) {
        badge = { text: "⛔ Expirado", tone: "bad" };
        headline = "Este acceso ya expiró";
        bodyHtml = `
          <div class="card">
            <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
            <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            <div class="row"><span class="k">Check-out</span><span class="v">${escapeHtml(fmtLocal(checkOut))}</span></div>
          </div>
          <p class="muted">Si necesitas extender el acceso, contacta al host.</p>
        `;
      }

      // 🔓 Activo
      else if (active) {
        badge = { text: "🔓 Activo", tone: "good" };
        headline = "Tu acceso está activo";
        bodyHtml = `
          <div class="card">
            <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
            <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            <div class="row"><span class="k">Válido hasta</span><span class="v">${escapeHtml(fmtLocal(active.endsAt))}</span></div>
          </div>

          <div class="card">
            <div class="row">
              <span class="k">Código</span>
              <span class="v code">${escapeHtml(active.accessCodeMasked ?? "Enviado por mensaje")}</span>
            </div>
            <p class="muted small">Por seguridad el código completo no se muestra aquí.</p>
          </div>
        `;
      }

      // ⏳ Pendiente
      else if (pending) {
        badge = { text: "⏳ Pendiente", tone: "warn" };

        if (now < pending.startsAt) {
          headline = "Tu acceso se activará en el check-in";
          bodyHtml = `
            <div class="card">
              <div class="row"><span class="k">Check-in</span><span class="v">${escapeHtml(fmtLocal(checkIn))}</span></div>
              <div class="row"><span class="k">Check-out</span><span class="v">${escapeHtml(fmtLocal(checkOut))}</span></div>
            </div>
            <p class="muted">Vuelve a abrir este enlace cerca del check-in.</p>
          `;
        } else {
          headline = "Estamos activando tu acceso";
          bodyHtml = `
            <div class="card">
              <div class="row"><span class="k">Propiedad</span><span class="v">${escapeHtml(reservation.property?.name ?? "N/A")}</span></div>
              <div class="row"><span class="k">Puerta</span><span class="v">${escapeHtml(lockName)}</span></div>
            </div>

            <div class="card">
              <div class="row">
                <span class="k">Estado</span>
                <span class="v"><span id="autorefresh" class="muted">Auto-actualizando…</span></span>
              </div>
            </div>

            <p class="muted">Esto suele tardar menos de 1 minuto.</p>
          `;
        }
      }

      // ⛔ Revocado
      else if (revoked) {
        badge = { text: "⛔ Revocado", tone: "bad" };
        headline = "Este acceso fue revocado";
        bodyHtml = `<p class="muted">Contacta al host si crees que es un error.</p>`;
      }

      // Sin grants
      else {
        badge = { text: "⛔ Sin acceso", tone: "bad" };
        headline = "No hay credenciales asociadas";
        bodyHtml = `<p class="muted">Contacta al host para soporte.</p>`;
      }

      return res.status(200).type("html").send(
        renderPage({
          title: "Pin&Go • Acceso",
          badge,
          body: `
            <h1>${escapeHtml(headline)}</h1>
            <p class="sub">Hola <b>${escapeHtml(reservation.guestName ?? "Guest")}</b></p>
            ${bodyHtml}
            ${autoRefreshScript(shouldAutoRefresh)}
            <div class="footer">
              <span class="brand">Pin&Go</span>
              <span class="muted small">Control de acceso • Seguro • Automático</span>
            </div>
          `,
        })
      );
    } catch (e: any) {
      console.error("guest portal error:", e?.message ?? e);
      return res.status(500).type("html").send(
        renderPage({
          title: "Pin&Go • Error",
          badge: { text: "⚠️ Error", tone: "bad" },
          body: `<p class="muted">Ocurrió un error cargando el acceso.</p>`,
        })
      );
    }
  });

  // ✅ Alias opcional (si quieres mantener /checkin/:token)
  router.get("/checkin/:token", (req, res) => {
    const token = String(req.params.token ?? "").trim();
    return res.redirect(`/guest/${encodeURIComponent(token)}`);
  });

  return router;
}

/* =====================
   HTML Layout
===================== */
function renderPage(args: {
  title: string;
  badge: { text: string; tone: "good" | "warn" | "bad" };
  body: string;
}) {
  const toneClass =
    args.badge.tone === "good" ? "good" : args.badge.tone === "warn" ? "warn" : "bad";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(args.title)}</title>
  <style>
    :root { --bg:#0b1220; --card:#121a2b; --txt:#e7eefc; --mut:#9db0d1; --line:#24304a; }
    body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--txt); }
    .wrap { max-width:720px; margin:0 auto; padding:24px 16px 40px; }
    .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .logo { font-weight:800; }
    .badge { font-size:13px; padding:6px 10px; border-radius:999px; border:1px solid var(--line); }
    .badge.good { background:rgba(36,180,120,.14); }
    .badge.warn { background:rgba(240,180,60,.14); }
    .badge.bad  { background:rgba(240,80,80,.14); }
    h1 { margin:10px 0 6px; font-size:22px; }
    .sub { margin:0 0 14px; color:var(--mut); }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin:12px 0; }
    .row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; }
    .k { color:var(--mut); font-size:13px; }
    .v { font-size:14px; text-align:right; }
    .code { font-weight:800; }
    .muted { color:var(--mut); }
    .small { font-size:12px; }
    .footer { margin-top:18px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
    .brand { font-weight:800; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="logo">Pin&Go</div>
      <div class="badge ${toneClass}">${escapeHtml(args.badge.text)}</div>
    </div>
    ${args.body}
  </div>
</body>
</html>`;
}
