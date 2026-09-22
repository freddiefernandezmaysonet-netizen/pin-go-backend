import { Router, type Request, type Response } from "express";

import { requireAuth } from "../middleware/requireAuth.js";
import {
  normalizePropertyKnowledgeEntryDraft,
} from "../pin-ai/property-knowledge-entry.contract.js";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
const CREATE_FIELDS = new Set([
  "category",
  "key",
  "titleEn",
  "titleEs",
  "contentEn",
  "contentEs",
  "visibility",
  "sortOrder",
]);
const UPDATE_FIELDS = new Set([...CREATE_FIELDS, "expectedRevision"]);
const DEACTIVATE_FIELDS = new Set(["expectedRevision"]);

type AuthenticatedActor = Readonly<{
  id: string;
  orgId: string;
  role: string;
}>;

export type PropertyKnowledgeAdminPrisma = Readonly<{
  property: Readonly<{
    findFirst(args: unknown): Promise<{ id: string } | null>;
  }>;
  propertyKnowledgeEntry: Readonly<{
    findMany(args: unknown): Promise<any[]>;
    findFirst(args: unknown): Promise<any | null>;
    create(args: unknown): Promise<any>;
    updateMany(args: unknown): Promise<{ count: number }>;
  }>;
}>;

function actor(req: Request): AuthenticatedActor | null {
  const user = (req as Request & {
    user?: { id?: string; orgId?: string; role?: string };
  }).user;

  if (
    !user?.id ||
    !user.orgId ||
    !user.role ||
    !ADMIN_ROLES.has(user.role)
  ) {
    return null;
  }

  return {
    id: user.id,
    orgId: user.orgId,
    role: user.role,
  };
}

function bodyRecord(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw routeError(400, "PROPERTY_KNOWLEDGE_BODY_INVALID");
  }
  return req.body as Record<string, unknown>;
}

function assertAllowedFields(
  input: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw routeError(400, "PROPERTY_KNOWLEDGE_FIELD_NOT_ALLOWED");
    }
  }
}

function expectedRevision(input: Readonly<Record<string, unknown>>): number {
  const revision = Number(input.expectedRevision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw routeError(400, "PROPERTY_KNOWLEDGE_REVISION_REQUIRED");
  }
  return revision;
}

function mergeDraft(existing: any, input: Readonly<Record<string, unknown>>) {
  const value = (key: string) =>
    Object.prototype.hasOwnProperty.call(input, key)
      ? input[key]
      : existing[key];

  return normalizePropertyKnowledgeEntryDraft({
    category: value("category"),
    key: value("key"),
    titleEn: value("titleEn"),
    titleEs: value("titleEs"),
    contentEn: value("contentEn"),
    contentEs: value("contentEs"),
    visibility: value("visibility"),
    sortOrder: value("sortOrder"),
  });
}

async function requireActiveProperty(
  prisma: PropertyKnowledgeAdminPrisma,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (!property) {
    throw routeError(404, "PROPERTY_KNOWLEDGE_PROPERTY_NOT_FOUND");
  }
}

function entryWhere(
  organizationId: string,
  propertyId: string,
  entryId: string,
) {
  return {
    id: entryId,
    propertyId,
    property: {
      organizationId,
      status: "ACTIVE",
    },
  };
}

function serializeEntry(entry: any) {
  return {
    id: entry.id,
    propertyId: entry.propertyId,
    category: entry.category,
    key: entry.key,
    titleEn: entry.titleEn,
    titleEs: entry.titleEs,
    contentEn: entry.contentEn,
    contentEs: entry.contentEs,
    visibility: entry.visibility,
    sortOrder: entry.sortOrder,
    revision: entry.revision,
    isActive: entry.isActive,
    createdAt:
      entry.createdAt instanceof Date
        ? entry.createdAt.toISOString()
        : entry.createdAt,
    updatedAt:
      entry.updatedAt instanceof Date
        ? entry.updatedAt.toISOString()
        : entry.updatedAt,
  };
}

function routeError(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

function sendError(res: Response, error: unknown) {
  const value = error as { status?: number; code?: string; message?: string };
  const code = value?.code ?? value?.message ?? "PROPERTY_KNOWLEDGE_ROUTE_ERROR";

  if (code === "P2002") {
    return res.status(409).json({
      ok: false,
      error: "PROPERTY_KNOWLEDGE_KEY_CONFLICT",
    });
  }

  if (code.startsWith("PROPERTY_KNOWLEDGE_")) {
    return res.status(value.status ?? 400).json({ ok: false, error: code });
  }

  console.error("[PROPERTY_KNOWLEDGE_ADMIN_ROUTE_ERROR]", error);
  return res.status(500).json({
    ok: false,
    error: "PROPERTY_KNOWLEDGE_ROUTE_ERROR",
  });
}

export function buildDashboardPropertyKnowledgeRouter(
  prisma: PropertyKnowledgeAdminPrisma,
) {
  const router = Router();

  router.use(
    "/api/dashboard/properties/:propertyId/property-knowledge",
    requireAuth,
    (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actor(req)) {
        return res.status(403).json({
          ok: false,
          error: "PROPERTY_KNOWLEDGE_ADMIN_FORBIDDEN",
        });
      }
      return next();
    },
  );

  router.get(
    "/api/dashboard/properties/:propertyId/property-knowledge",
    async (req, res) => {
      try {
        const currentActor = actor(req)!;
        const propertyId = String(req.params.propertyId ?? "").trim();
        if (!propertyId) {
          throw routeError(400, "PROPERTY_KNOWLEDGE_PROPERTY_ID_REQUIRED");
        }

        await requireActiveProperty(
          prisma,
          currentActor.orgId,
          propertyId,
        );

        const includeInactive = req.query.includeInactive === "true";
        const entries = await prisma.propertyKnowledgeEntry.findMany({
          where: {
            propertyId,
            ...(includeInactive ? {} : { isActive: true }),
          },
          orderBy: [
            { category: "asc" },
            { sortOrder: "asc" },
            { key: "asc" },
          ],
        });

        return res.json({
          ok: true,
          propertyId,
          entries: entries.map(serializeEntry),
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  router.post(
    "/api/dashboard/properties/:propertyId/property-knowledge",
    async (req, res) => {
      try {
        const currentActor = actor(req)!;
        const propertyId = String(req.params.propertyId ?? "").trim();
        if (!propertyId) {
          throw routeError(400, "PROPERTY_KNOWLEDGE_PROPERTY_ID_REQUIRED");
        }
        const input = bodyRecord(req);
        assertAllowedFields(input, CREATE_FIELDS);
        const draft = normalizePropertyKnowledgeEntryDraft(input);

        await requireActiveProperty(
          prisma,
          currentActor.orgId,
          propertyId,
        );

        const entry = await prisma.propertyKnowledgeEntry.create({
          data: {
            propertyId,
            ...draft,
            createdByUserId: currentActor.id,
            updatedByUserId: currentActor.id,
          },
        });

        return res.status(201).json({ ok: true, entry: serializeEntry(entry) });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  router.patch(
    "/api/dashboard/properties/:propertyId/property-knowledge/:entryId",
    async (req, res) => {
      try {
        const currentActor = actor(req)!;
        const propertyId = String(req.params.propertyId ?? "").trim();
        const entryId = String(req.params.entryId ?? "").trim();
        if (!propertyId || !entryId) {
          throw routeError(400, "PROPERTY_KNOWLEDGE_TARGET_REQUIRED");
        }
        const input = bodyRecord(req);
        assertAllowedFields(input, UPDATE_FIELDS);
        const revision = expectedRevision(input);

        const existing = await prisma.propertyKnowledgeEntry.findFirst({
          where: {
            ...entryWhere(currentActor.orgId, propertyId, entryId),
            isActive: true,
          },
        });
        if (!existing) {
          throw routeError(404, "PROPERTY_KNOWLEDGE_ENTRY_NOT_FOUND");
        }
        if (existing.revision !== revision) {
          throw routeError(409, "PROPERTY_KNOWLEDGE_REVISION_CONFLICT");
        }

        const draft = mergeDraft(existing, input);
        const update = await prisma.propertyKnowledgeEntry.updateMany({
          where: {
            id: entryId,
            propertyId,
            revision,
            isActive: true,
            property: {
              organizationId: currentActor.orgId,
              status: "ACTIVE",
            },
          },
          data: {
            ...draft,
            revision: { increment: 1 },
            updatedByUserId: currentActor.id,
          },
        });
        if (update.count !== 1) {
          throw routeError(409, "PROPERTY_KNOWLEDGE_REVISION_CONFLICT");
        }

        const entry = await prisma.propertyKnowledgeEntry.findFirst({
          where: entryWhere(currentActor.orgId, propertyId, entryId),
        });
        if (!entry) {
          throw routeError(409, "PROPERTY_KNOWLEDGE_UPDATE_NOT_OBSERVABLE");
        }

        return res.json({ ok: true, entry: serializeEntry(entry) });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  router.delete(
    "/api/dashboard/properties/:propertyId/property-knowledge/:entryId",
    async (req, res) => {
      try {
        const currentActor = actor(req)!;
        const propertyId = String(req.params.propertyId ?? "").trim();
        const entryId = String(req.params.entryId ?? "").trim();
        if (!propertyId || !entryId) {
          throw routeError(400, "PROPERTY_KNOWLEDGE_TARGET_REQUIRED");
        }
        const input = bodyRecord(req);
        assertAllowedFields(input, DEACTIVATE_FIELDS);
        const revision = expectedRevision(input);

        const existing = await prisma.propertyKnowledgeEntry.findFirst({
          where: {
            ...entryWhere(currentActor.orgId, propertyId, entryId),
            isActive: true,
          },
        });
        if (!existing) {
          throw routeError(404, "PROPERTY_KNOWLEDGE_ENTRY_NOT_FOUND");
        }
        if (existing.revision !== revision) {
          throw routeError(409, "PROPERTY_KNOWLEDGE_REVISION_CONFLICT");
        }

        const update = await prisma.propertyKnowledgeEntry.updateMany({
          where: {
            id: entryId,
            propertyId,
            revision,
            isActive: true,
            property: {
              organizationId: currentActor.orgId,
              status: "ACTIVE",
            },
          },
          data: {
            isActive: false,
            revision: { increment: 1 },
            updatedByUserId: currentActor.id,
          },
        });
        if (update.count !== 1) {
          throw routeError(409, "PROPERTY_KNOWLEDGE_REVISION_CONFLICT");
        }

        return res.json({
          ok: true,
          entryId,
          isActive: false,
          revision: revision + 1,
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  return router;
}
