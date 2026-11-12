import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth.js";
assert.equal(process.env.RAILWAY_SERVICE_ID, "4cfd2dfd-3664-4bc6-b5cf-7ca765092f7a");
assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, "9833f06b-463f-4551-bda7-a9a1eaaa9aa6");
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, "pin-ai-hybrid-e2e-db.railway.internal");
assert.equal(database.searchParams.get("schema"), "direct_discounts_certification");
assert.equal(process.env.NODE_ENV, "test");
assert.ok((process.env.CERT_UI_PASSWORD ?? "").length >= 24);
assert.ok(!process.env.ENABLE_DEV_AUTH && !process.env.CI);
for (const key of ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "CHANNEX_API_KEY", "TTLOCK_ACCESS_TOKEN", "OPENAI_API_KEY"])
  assert.ok(!process.env[key], "External operations prohibited");
const db = new PrismaClient();
const property = await db.property.findUniqueOrThrow({ where: { id: "cmwcizx320002mz1boxprmhz2" }, include: { organization: true } });
assert.equal(property.organization.name, "Synthetic discount certification");
assert.equal(property.name, "PRUEBA Pin&Go descuentos");
const email = "discount-ui@example.com";
await db.dashboardUser.upsert({ where: { email }, create: { email, organizationId: property.organizationId,
  passwordHash: await hashPassword(process.env.CERT_UI_PASSWORD!), fullName: "Synthetic UI Tester", role: "ORG_ADMIN" },
  update: { passwordHash: await hashPassword(process.env.CERT_UI_PASSWORD!), tokenVersion: { increment: 1 } } });
const app = express();
const origins = (process.env.FRONTEND_ORIGIN ?? "").split(",").filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin)), credentials: true }));
app.use(express.json());
app.get("/ready", (_req, res) => res.json({ ready: true, synthetic: true }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" || req.method === "HEAD" ||
      (req.method === "POST" && ["/auth/login", "/auth/logout", "/auth/session/activity"].includes(req.path)) ||
      (req.method === "PUT" && /^\/api\/dashboard\/properties\/[^/]+\/direct-discounts$/.test(req.path)) ||
      (req.method === "POST" && /^\/api\/dashboard\/properties\/[^/]+\/direct-discounts\/preview$/.test(req.path))) return next();
  res.status(403).json({ error: "CERTIFICATION_READ_ONLY" });
});
const { authRouter } = await import("../routes/auth.routes.js");
const { dashboardPropertiesRouter } = await import("../routes/dashboard.properties.route.js");
const { directDiscountsRouter } = await import("../routes/dashboard.direct-discounts.routes.js");
const { publicBrandContextRouter } = await import("../routes/public.brand-context.routes.js");
app.use(authRouter);
app.use(publicBrandContextRouter);
app.use(directDiscountsRouter);
app.use(dashboardPropertiesRouter);
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(JSON.stringify({ stage: "UI_READY", propertyId: property.id, synthetic: true })));
setTimeout(() => { server.close(); void db.$disconnect().finally(() => process.exit(0)); }, 2 * 60 * 60 * 1000).unref();
