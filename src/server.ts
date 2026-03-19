import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import bodyParser from "body-parser";
import { registerStripeWebhook } from "./webhooks/stripe.webhook";
import cors from "cors";

// Routers
import { pmsWebhookRouter } from "./pms/ingest/webhook.routes";
import { buildTTLockRouter } from "./routes/ttlock.routes";
import { buildReservationRouter } from "./routes/reservation.routes";
import { buildAccessRouter } from "./routes/access.routes";
import { reservationsRouter } from "./routes/reservations.routes";
import { buildGuestRouter } from "./routes/guest.routes";
import { buildBillingRouter } from "./routes/billing.routes";
import { buildBillingPortalRouter } from "./routes/billing.portal.route";
import billingPreviewRouter from "./routes/billing.preview.routes";
import billingCapacityRouter from "./routes/billing.capacity.routes";
import ingestRoutes from "./routes/ingest.routes";
import { buildStaffRouter } from "./routes/staff.routes";
import { buildCleaningRouter } from "./routes/cleaning.routes";
import adminReactivateRoutes from "./routes/admin.reactivate.routes";
// import devRoutes from "./routes/dev.routes";
import { buildAccessNfcRouter } from "./routes/access.nfc.routes";
import { buildAdminNfcRouter } from "./routes/admin.nfc.routes";
import buildNfcSyncRouter from "./routes/nfc.sync.routes";
import { buildCreatePropertyRouter } from "./routes/properties.create.route";
import { buildPropertySettingsRouter } from "./routes/property.settings.routes";
import { buildPropertiesRouter } from "./routes/properties.route";
import { buildAdminLocksRouter } from "./routes/admin.locks.routes";
import { buildAdminLocksSwapRouter } from "./routes/admin.locks.swap.routes";
import buildDeviceHealthRouter from "./routes/deviceHealth.routes";
// import { buildAdminDeviceHealthRouter } from "./routes/admin.deviceHealth.routes";
import buildDeviceBatteryRouter from "./routes/deviceBattery.routes";
import buildDeviceGatewayRouter from "./routes/deviceGateway.routes";
import adminUsageRoutes from "./routes/admin.usage.routes";
import adminCapacityRoutes from "./routes/admin.capacity.routes";
import adminSubscriptionRoutes from "./routes/admin.subscription.routes";
import { debugRouter } from "./routes/debug.routes";
// import nfcSyncRouter from "./routes/nfc.sync.routes";
import { listingsMappingRouter } from "./pms/routes/listings.mapping.routes";
import { meRouter } from "./routes/me.route";
import { dashboardRouter } from "./routes/dashboard.route";
import { dashboardReservationsRouter } from "./routes/dashboard.reservations.route";
import { dashboardPropertiesRouter } from "./routes/dashboard.properties.route";
import { dashboardLocksRouter } from "./routes/dashboard.locks.route";
import { dashboardAccessRouter } from "./routes/dashboard.access.route";
import { dashboardMetricsRouter } from "./routes/dashboard.metrics.route";
import { dashboardLocksCapacityRouter } from "./routes/dashboard.locks.capacity.route";
import { dashboardAlertsRouter } from "./routes/dashboard.alerts.route";
import { buildDashboardHealthRouter } from "./routes/dashboard.health.routes";
import { buildOrgPmsRouter } from "./routes/org.pms.routes";
import { dashboardPmsRouter } from "./routes/dashboard.pms.route";
import { devPmsRouter } from "./routes/dev.pms.routes";
import { authRouter } from "./routes/auth.routes";
import { eventsRouter } from "./routes/events.route";

import { buildOrgTtlockSyncRouter } from "./routes/org.ttlock.sync.router";
import { buildOrgLocksSwapRouter } from "./routes/org.locks.swap.router";
import { buildOrgTtlockInventoryRouter } from "./routes/org.ttlock.inventory.router";
import { buildOrgLocksActivateV2Router } from "./routes/org.locks.activate.v2.router";
import { buildOrgTtlockConnectV2Router } from "./routes/org.ttlock.connect.v2.router";
import { buildBillingOverviewRouter } from "./routes/billing.overview.route";
import { orgTtlockStatusRouter } from "./routes/org.ttlock.status.route";
import signupPublicRoutes from "./routes/public.signup.routes";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
const ENABLE_DEV_AUTH = process.env.ENABLE_DEV_AUTH === "true";

// =====================
// ENV CHECK (solo log)
// =====================
console.log("ENV CHECK TTLOCK:", {
  clientId: process.env.TTLOCK_CLIENT_ID ? "OK" : "MISSING",
  clientSecret: process.env.TTLOCK_CLIENT_SECRET ? "OK" : "MISSING",
  username: process.env.TTLOCK_USERNAME ? "OK" : "MISSING",
  password: process.env.TTLOCK_PASSWORD_PLAIN ? "OK" : "MISSING",
});

// =====================
// Webhooks primero
// =====================
registerStripeWebhook(app);

// =====================
// Middleware
// =====================
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(bodyParser.urlencoded({ extended: true }));

// Dev auth fallback controlado por env.
// Mantiene estabilidad mientras migras el dashboard al login real.
if (ENABLE_DEV_AUTH) {
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "dev-user",
      email: "dev@pingo.com",
      orgId: "cmlk0fpl60000n0o0vo87t6tm",
      role: "ADMIN",
    };
    next();
  });

  console.log("[auth] ENABLE_DEV_AUTH=true -> req.user manual activo");
} else {
  console.log("[auth] ENABLE_DEV_AUTH=false -> auth real por login/token");
}

// =====================
// Health
// =====================
app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "Pin&Go API" });
});

// =====================
// Public / open routes
// =====================
app.use(signupPublicRoutes);
app.use(authRouter);

// Debug públicos temporales
app.get("/api/dev/test-open", (_req, res) => {
  console.log(">>> OPEN DEV TEST HIT");
  res.json({ ok: true, route: "open-dev-test" });
});

app.get("/api/dev/locks/:lockId/device-health-test", (req, res) => {
  console.log(">>> DIRECT SERVER DEVICE HEALTH TEST HIT", req.params.lockId);
  res.json({
    ok: true,
    lockId: req.params.lockId,
  });
});

// =====================
// Auth-related / user session
// =====================
app.use(meRouter);
app.use(orgTtlockStatusRouter);

// =====================
// Guest Portal (HTML)
// =====================
app.use(buildGuestRouter(prisma));

// =====================
// Ingest API
// =====================
app.use("/api/ingest", ingestRoutes);

// =====================
// Device / alerts
// =====================
app.use(buildDeviceHealthRouter(prisma));
app.use(buildDeviceBatteryRouter(prisma));
app.use(buildDeviceGatewayRouter(prisma));
app.use(dashboardAlertsRouter);

// =====================
// Core Routers
// =====================
app.use("/ttlock", buildTTLockRouter(prisma));
app.use("/reservation", buildReservationRouter(prisma));
app.use("/access", buildAccessRouter(prisma));
app.use("/reservations", reservationsRouter);
app.use("/billing", buildBillingRouter(prisma));
app.use("/billing", buildBillingOverviewRouter(prisma));
app.use("/billing", buildBillingPortalRouter(prisma));
app.use("/billing", billingCapacityRouter);
app.use("/billing", billingPreviewRouter);

app.use(buildCreatePropertyRouter(prisma));
app.use(buildPropertiesRouter(prisma));

// app.use(buildAdminDeviceHealthRouter(prisma));

app.use("/api/admin", adminReactivateRoutes);
// app.use("/api/dev", devRoutes);

app.use("/access/nfc", buildAccessNfcRouter(prisma));
app.use("/dev", buildAdminNfcRouter(prisma));
app.use("/access/nfc", buildNfcSyncRouter(prisma));

app.use("/api/admin/properties", buildPropertySettingsRouter(prisma));
app.use("/api/admin", buildAdminLocksRouter(prisma));
app.use("/api/admin", buildAdminLocksSwapRouter(prisma));
app.use("/api/admin", adminUsageRoutes);
app.use("/api/admin", adminCapacityRoutes);
app.use("/api/admin", adminSubscriptionRoutes);

app.use("/debug", debugRouter);
// app.use("/access/nfc", nfcSyncRouter);

app.use("/webhooks", pmsWebhookRouter);
app.use("/api/pms/listings", listingsMappingRouter);
app.use("/api/org", buildOrgPmsRouter(prisma));

app.use("/api/org", buildOrgTtlockSyncRouter(prisma));
app.use("/api/org", buildOrgLocksSwapRouter(prisma));
app.use("/api/org", buildOrgTtlockInventoryRouter(prisma));
app.use("/api/org", buildOrgLocksActivateV2Router(prisma));
app.use("/api/org", buildOrgTtlockConnectV2Router(prisma));

app.use("/api/dashboard/health", buildDashboardHealthRouter(prisma));
app.use(dashboardRouter);
app.use(dashboardReservationsRouter);
app.use(dashboardPropertiesRouter);
app.use(dashboardLocksRouter);
app.use(dashboardAccessRouter);
app.use(dashboardMetricsRouter);
app.use(dashboardLocksCapacityRouter);
app.use(dashboardPmsRouter);
app.use(devPmsRouter);
app.use(eventsRouter);

// =====================
// Staff + Cleaning
// =====================
app.use("/staff", buildStaffRouter(prisma));
app.use("/", buildCleaningRouter(prisma));

// =====================
// Debug helpers (mínimos)
// =====================
app.get("/debug/locks", async (_req, res) => {
  const locks = await prisma.lock.findMany({
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  res.json({ ok: true, locks });
});

app.get("/debug/reservations/latest", async (_req, res) => {
  const items = await prisma.reservation.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      guestName: true,
      checkIn: true,
      checkOut: true,
      guestToken: true,
      guestTokenExpiresAt: true,
      createdAt: true,
    },
  });

  res.json({ ok: true, items });
});

app.post("/debug/reservations/:id/fix-token", async (req, res) => {
  const id = String(req.params.id);

  const r = await prisma.reservation.findUnique({
    where: { id },
    select: { id: true, checkOut: true },
  });

  if (!r) {
    return res.status(404).json({ ok: false, error: "Reservation not found" });
  }

  const guestToken = crypto.randomUUID();
  const guestTokenExpiresAt = new Date(
    r.checkOut.getTime() + 24 * 60 * 60 * 1000
  );

  const updated = await prisma.reservation.update({
    where: { id },
    data: { guestToken, guestTokenExpiresAt },
  });

  res.json({ ok: true, updated });
});

export default app;

// =====================
// Start server
// =====================
app.listen(PORT, () => {
  console.log("✅ property settings routes loaded");

  console.log("[server] ENV", {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    frontendOrigin: FRONTEND_ORIGIN,
    enableDevAuth: ENABLE_DEV_AUTH,
  });

  console.log(`🚀 Pin&Go API running on http://localhost:${PORT}`);
});