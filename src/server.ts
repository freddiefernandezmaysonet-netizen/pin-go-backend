import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import bodyParser from "body-parser";
import { registerStripeWebhook } from "./webhooks/stripe.webhook";
import cors from "cors";

// Routers (NO TOCAR)
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
import { buildAccessNfcRouter } from "./routes/access.nfc.routes";
import { buildAdminNfcRouter } from "./routes/admin.nfc.routes";
import buildNfcSyncRouter from "./routes/nfc.sync.routes";
import { buildPropertySettingsRouter } from "./routes/property.settings.routes";
import { buildPropertiesRouter } from "./routes/properties.route";
import { buildAdminLocksRouter } from "./routes/admin.locks.routes";
import { buildAdminLocksSwapRouter } from "./routes/admin.locks.swap.routes";
import buildDeviceHealthRouter from "./routes/deviceHealth.routes";
import buildDeviceBatteryRouter from "./routes/deviceBattery.routes";
import buildDeviceGatewayRouter from "./routes/deviceGateway.routes";
import adminUsageRoutes from "./routes/admin.usage.routes";
import adminCapacityRoutes from "./routes/admin.capacity.routes";
import adminSubscriptionRoutes from "./routes/admin.subscription.routes";
import { debugRouter } from "./routes/debug.routes";
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
import messagesRouter from "./routes/dashboard.messages.routes";

import { buildOrgTtlockSyncRouter } from "./routes/org.ttlock.sync.router";
import { buildOrgLocksSwapRouter } from "./routes/org.locks.swap.router";
import { buildOrgTtlockInventoryRouter } from "./routes/org.ttlock.inventory.router";
import { buildOrgLocksActivateV2Router } from "./routes/org.locks.activate.v2.router";
import { buildOrgTtlockConnectV2Router } from "./routes/org.ttlock.connect.v2.router";
import { buildBillingOverviewRouter } from "./routes/billing.overview.route";
import { orgTtlockStatusRouter } from "./routes/org.ttlock.status.route";
import signupPublicRoutes from "./routes/public.signup.routes";
import tuyaRoutes from "./routes/tuya.routes";
import orgTuyaRoutes from "./routes/org.tuya.routes";
import devAutomationRoutes from "./routes/dev.automation.routes";
import { buildPropertyAutomationRouter } from "./routes/property.automation.routes";
import buildTuyaAccessRouter from "./routes/tuya.access.routes";
import buildTuyaBillingRouter from "./routes/tuya.billing.routes";
import adminFinancialRoutes from "./routes/admin.financial.routes";
import ttlockDisconnectRoutes from "./routes/org/ttlock.disconnect.routes";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
const ENABLE_DEV_AUTH = process.env.ENABLE_DEV_AUTH === "true";

// =====================
// 🔒 CRÍTICO PRODUCCIÓN
// =====================
app.set("trust proxy", 1);

// =====================
// ENV VALIDATION (mínima)
// =====================
if (!process.env.DATABASE_URL) {
  throw new Error("❌ DATABASE_URL missing");
}

if (!process.env.JWT_SECRET) {
  throw new Error("❌ JWT_SECRET missing");
}

if (!FRONTEND_ORIGIN) {
  throw new Error("❌ FRONTEND_ORIGIN missing");
}

// =====================
// CORS
// =====================
const allowedOrigins = [
  FRONTEND_ORIGIN,
  "http://localhost:5173",
  "http://localhost:4173",
];

// =====================
// LOG SAFE
// =====================
console.log("[server] ENV CHECK", {
  nodeEnv: process.env.NODE_ENV,
  database: process.env.DATABASE_URL ? "SET" : "MISSING",
  jwtSecret: process.env.JWT_SECRET ? "SET" : "MISSING",
  frontendOrigin: FRONTEND_ORIGIN,
  enableDevAuth: ENABLE_DEV_AUTH,
});

console.log("[server] START", {
  port: PORT,
  env: process.env.NODE_ENV,
});

// =====================
// Webhooks PRIMERO
// =====================
registerStripeWebhook(app);

// =====================
// Middleware
// =====================
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
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

// =====================
// Health
// =====================
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ✅ readiness real (DB)
app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (err) {
    console.error("READY CHECK FAILED", err);
    res.status(500).json({ ok: false });
  }
});

// =====================
// Public routes
// =====================
app.use(signupPublicRoutes);
app.use(authRouter);

// =====================
// DEV ROUTES (bloqueadas en producción)
// =====================
if (process.env.NODE_ENV !== "production") {
  app.get("/api/dev/test-open", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/dev/locks/:lockId/device-health-test", (req, res) => {
    res.json({ ok: true, lockId: req.params.lockId });
  });
}

// =====================
// Core
// =====================
app.use(meRouter);
app.use(orgTtlockStatusRouter);
app.use(buildGuestRouter(prisma));
app.use("/api/ingest", ingestRoutes);

app.use(buildDeviceHealthRouter(prisma));
app.use(buildDeviceBatteryRouter(prisma));
app.use(buildDeviceGatewayRouter(prisma));
app.use(dashboardAlertsRouter);

app.use("/ttlock", buildTTLockRouter(prisma));
app.use("/reservation", buildReservationRouter(prisma));
app.use("/access", buildAccessRouter(prisma));
app.use("/reservations", reservationsRouter);

app.use("/billing", buildBillingRouter(prisma));
app.use("/billing", buildBillingOverviewRouter(prisma));
app.use("/billing", buildBillingPortalRouter(prisma));
app.use("/billing", billingCapacityRouter);
app.use("/billing", billingPreviewRouter);

app.use(buildPropertiesRouter(prisma));
app.use("/api/properties", buildPropertyAutomationRouter(prisma));

app.use("/api/admin", adminReactivateRoutes);

app.use("/access/nfc", buildAccessNfcRouter(prisma));
app.use("/dev", buildAdminNfcRouter(prisma));
app.use("/access/nfc", buildNfcSyncRouter(prisma));

app.use("/api/admin/properties", buildPropertySettingsRouter(prisma));
app.use("/api/admin", buildAdminLocksRouter(prisma));
app.use("/api/admin", buildAdminLocksSwapRouter(prisma));
app.use("/api/admin", adminUsageRoutes);
app.use("/api/admin", adminCapacityRoutes);
app.use("/api/admin", adminSubscriptionRoutes);
app.use("/api/admin", adminFinancialRoutes);

if (process.env.NODE_ENV !== "production") {
app.use("/debug", debugRouter);
}

app.use("/webhooks", pmsWebhookRouter);
app.use("/api/pms/listings", listingsMappingRouter);
app.use("/api/org", buildOrgPmsRouter(prisma));

app.use("/api/org", buildOrgTtlockSyncRouter(prisma));
app.use("/api/org", buildOrgLocksSwapRouter(prisma));
app.use("/api/org", buildOrgTtlockInventoryRouter(prisma));
app.use("/api/org", buildOrgLocksActivateV2Router(prisma));
app.use("/api/org", buildOrgTtlockConnectV2Router(prisma));

app.use("/api/org/tuya/access", buildTuyaAccessRouter(prisma));
app.use("/api/org/tuya/billing", buildTuyaBillingRouter(prisma));

app.use("/api/dashboard", messagesRouter);
app.use("/api/dashboard/health", buildDashboardHealthRouter(prisma));
app.use("/api/org", ttlockDisconnectRoutes);

app.use(dashboardRouter);
app.use(dashboardReservationsRouter);
app.use(dashboardPropertiesRouter);
app.use(dashboardLocksRouter);
app.use(dashboardAccessRouter);
app.use(dashboardMetricsRouter);
app.use(dashboardLocksCapacityRouter);
app.use(dashboardPmsRouter);

if (process.env.NODE_ENV !== "production") {
  app.use(devPmsRouter);
}

app.use(devAutomationRoutes);

app.use(eventsRouter);
app.use(tuyaRoutes);
app.use(orgTuyaRoutes);

app.use("/staff", buildStaffRouter(prisma));
app.use("/", buildCleaningRouter(prisma));

// =====================
// Debug protegido
// =====================
if (process.env.NODE_ENV !== "production") {
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
      return res.status(404).json({ ok: false });
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
}

// =====================
// Crash handling
// =====================
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err);
});

export default app;

// =====================
// Start server
// =====================
app.listen(PORT, () => {
  console.log(`🚀 Pin&Go API running on port ${PORT}`);
});