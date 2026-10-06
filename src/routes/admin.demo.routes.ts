import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { processWebhookEventById } from "../pms/ingest/webhook.processor";
import { DemoRunError, readDemoPreparation, readDemoRun, runInternalDemo } from "../services/internal-demo-run.service";

const prisma = new PrismaClient();
export function buildAdminDemoRunRouter(db = prisma, deps?: Parameters<typeof runInternalDemo>[3], env = process.env) {
const router = Router();
const actor = (req: any) => ({ userId: req.user?.id, organizationId: req.user?.orgId,
  email: req.user?.email ?? null, role: req.user?.role });
function failure(res: any, error: unknown) {
  return res.status(error instanceof DemoRunError ? error.status : 500).json({ ok: false,
    safeToEdit: error instanceof DemoRunError && error.safeToEdit,
    error: error instanceof DemoRunError ? error.code : "DEMO_OPERATION_FAILED" });
}
router.get("/api/internal/admin/demo/preparation", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store, private");
  try { res.json({ ok: true, data: await readDemoPreparation(db, actor(req), env) }); }
  catch (error) { failure(res, error); }
});
router.get("/api/internal/admin/demo/runs/:requestId", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store, private");
  try { res.json({ ok: true, data: await readDemoRun(db, actor(req), req.params.requestId) }); }
  catch (error) { failure(res, error); }
});
router.post("/api/internal/admin/demo/run", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store, private");
  try { const result = await runInternalDemo(db, actor(req), req.body, deps, env); res.status(result.ok ? 200 : 409).json(result); }
  catch (error) { failure(res, error); }
});

return router;
}
export const adminDemoRouter = buildAdminDemoRunRouter();

adminDemoRouter.post(
  "/api/internal/webhook-events/:id/reprocess",
  async (req, res) => {
    try {
      const { id } = req.params;

      const existing = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "WEBHOOK_EVENT_NOT_FOUND",
        });
      }

      await prisma.webhookEventIngest.update({
        where: { id },
        data: {
          status: "PENDING",
          lastError: null,
          processedAt: null,
        },
      });

      await processWebhookEventById(id);

      const processed = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      return res.json({
        ok: true,
        eventId: id,
        status: processed?.status ?? null,
        lastError: processed?.lastError ?? null,
        processedAt: processed?.processedAt ?? null,
      });
    } catch (error: any) {
      console.error("[WEBHOOK_REPROCESS_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "WEBHOOK_REPROCESS_FAILED",
      });
    }
  }
);
