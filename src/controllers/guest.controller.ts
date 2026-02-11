import type { Request, Response } from "express";
import { PrismaClient, AccessGrantType } from "@prisma/client";

const prisma = new PrismaClient();

export async function getGuestPortal(req: Request, res: Response) {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).send("Invalid link.");

    const reservation = await prisma.reservation.findUnique({
      where: { guestToken: token },
      include: {
        property: true,
        accessGrants: {
          where: { type: AccessGrantType.GUEST },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { lock: true },
        },
      },
    });

    if (!reservation) return res.status(404).send("Link not found.");

    // Expiry
    if (reservation.guestTokenExpiresAt && reservation.guestTokenExpiresAt < new Date()) {
      return res.status(410).send("This link has expired.");
    }

    const grant = reservation.accessGrants?.[0] ?? null;

    // Render HTML simple (sin React)
    return res.status(200).send(renderGuestHtml({ reservation, grant }));
  } catch (e: any) {
    return res.status(500).send(`Server error: ${e?.message ?? String(e)}`);
  }
}

function renderGuestHtml(input: { reservation: any; grant: any }) {
  const r = input.reservation;
  const g = input.grant;

  const status = g?.status ?? "NO_ACCESS";
  const propertyName = r?.property?.name ?? "Property";
  const room = r?.roomName ?? "";
  const checkIn = new Date(r.checkIn).toLocaleString();
  const checkOut = new Date(r.checkOut).toLocaleString();

  const masked = g?.accessCodeMasked ?? null;
  const unlockKey = g?.unlockKey ?? "#";

  const statusLabel =
    status === "ACTIVE"
      ? "✅ Access active"
      : status === "PENDING"
      ? "⏳ Access not active yet"
      : status === "REVOKED"
      ? "🚫 Access expired"
      : status === "FAILED"
      ? "⚠️ Access issue"
      : "ℹ️ No access configured";

  const codeSection =
    status === "ACTIVE" && masked
      ? `<div class="card">
           <h3>Your door code</h3>
           <p class="big">${unlockKey}${masked}</p>
           <p class="muted">For security, we don’t display the full code here.</p>
         </div>`
      : status === "PENDING"
      ? `<div class="card"><p>Your access will activate near check-in time.</p></div>`
      : status === "REVOKED"
      ? `<div class="card"><p>Your access window ended.</p></div>`
      : status === "FAILED"
      ? `<div class="card"><p>We’re having trouble preparing your access. Please contact support.</p></div>`
      : `<div class="card"><p>No access grant found.</p></div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pin&Go Guest Access</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#0b0f19;color:#e9eefc}
    .wrap{max-width:720px;margin:0 auto;padding:24px}
    .brand{font-weight:700;font-size:18px;margin-bottom:16px}
    .card{background:#121a2a;border:1px solid #1f2a44;border-radius:14px;padding:16px;margin:12px 0}
    .muted{opacity:.75}
    .big{font-size:28px;letter-spacing:1px;font-weight:800}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#1b2741;border:1px solid #2a3b63}
    a{color:#7fb2ff}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">Pin&Go — Guest Access</div>

    <div class="card">
      <div class="row">
        <span class="pill">${statusLabel}</span>
      </div>
      <h2 style="margin:10px 0 4px 0">${propertyName}</h2>
      <p class="muted" style="margin:0">${room ? `Unit: ${room}` : ""}</p>
      <p class="muted" style="margin:10px 0 0 0">
        Check-in: <b>${checkIn}</b><br/>
        Check-out: <b>${checkOut}</b>
      </p>
    </div>

    ${codeSection}

    <div class="card">
      <h3>Need help?</h3>
      <p class="muted">Reply to your confirmation message or contact your host.</p>
    </div>

  </div>
</body>
</html>`;
}
