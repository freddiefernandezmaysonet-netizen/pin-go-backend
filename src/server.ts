import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { prisma } from "./lib/prisma";
import bodyParser from "body-parser";
import { registerStripeWebhook } from "./webhooks/stripe.webhook";
import cors from "cors";

// Routers (NO TOCAR)
import { pmsWebhookRouter } from "./pms/ingest/webhook.routes";
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
import buildNfcSyncRouter from "./routes/nfc.sync.routes";
import { buildPropertySettingsRouter } from "./routes/property.settings.routes";
import { buildPropertiesRouter } from "./routes/properties.route";
import { buildAdminLocksRouter } from "./routes/dashboard.locks.route";
