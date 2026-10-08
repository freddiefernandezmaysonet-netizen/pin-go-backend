import type { Prisma, PrismaClient } from "@prisma/client";
import { assertCleaningActionTime, readCleaningActionWindow } from "./cleaning-action-window.js";
export type ChecklistTemplateItem = { id: string; es: string; en: string; required: boolean };
export class CleaningChecklistError extends Error { constructor(public code: string, public status = 409) { super(code); } }
export function parseChecklistItems(raw: unknown): ChecklistTemplateItem[] {
  if (!Array.isArray(raw) || raw.length > 50) throw new CleaningChecklistError("CHECKLIST_INVALID", 400);
  const keys = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || keys.has(item.id) || typeof item.required !== "boolean" || typeof item.es !== "string" || typeof item.en !== "string") throw new CleaningChecklistError("CHECKLIST_INVALID", 400);
    const es = item.es.trim(), en = item.en.trim();
    if ((!es && !en) || es.length > 500 || en.length > 500) throw new CleaningChecklistError("CHECKLIST_INVALID", 400);
    keys.add(item.id);
    return { id: item.id, es, en, required: item.required };
  });
}
export async function saveChecklistTemplate(db: PrismaClient, input: { propertyId: string; organizationId: string; userId: string; revision: number; items: unknown }) {
  const items = parseChecklistItems(input.items);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new CleaningChecklistError("CHECKLIST_INVALID", 400);
  return db.$transaction(async tx => {
    // Serialize host saves without blocking FK checks by reservation-locked readers.
    await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id" = ${input.propertyId} FOR NO KEY UPDATE`;
    const property = await tx.property.findFirst({ where: { id: input.propertyId, organizationId: input.organizationId }, select: { id: true } });
    if (!property) throw new CleaningChecklistError("PROPERTY_NOT_FOUND", 404);
    const existing = await tx.cleaningChecklistTemplate.findUnique({ where: { propertyId: input.propertyId } });
    if ((existing?.revision ?? 0) !== input.revision) throw new CleaningChecklistError("CHECKLIST_REVISION_CONFLICT");
    const saved = await tx.cleaningChecklistTemplate.upsert({ where: { propertyId: input.propertyId }, create: { propertyId: input.propertyId, revision: 1, items, updatedByUserId: input.userId }, update: { revision: { increment: 1 }, items, updatedByUserId: input.userId } });
    if (items.length) {
      // Use the same reservation fence as start, completion and item commands.
      // Lock in a stable order, then recheck eligibility under each lock.
      const reservations = await tx.$queryRaw<{ id: string }[]>`
        SELECT r."id" FROM "Reservation" r
        WHERE r."propertyId" = ${input.propertyId} AND r."status"::text = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM "CleaningConfirmation" o
            WHERE o."reservationId" = r."id" AND o."propertyId" = r."propertyId"
              AND o."status" IN ('PENDING', 'CONFIRMED'))
          AND NOT EXISTS (SELECT 1 FROM "CleaningWork" w WHERE w."reservationId" = r."id"
            AND (w."startConfirmedAt" IS NOT NULL OR w."completionConfirmedAt" IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM "CleaningTaskChecklist" c
            JOIN "CleaningTaskChecklistItem" i ON i."checklistId" = c."id"
            WHERE c."reservationId" = r."id")
        ORDER BY r."id" FOR UPDATE OF r`;
      for (const reservation of reservations) await ensureChecklistSnapshot(tx, reservation.id);
    }
    return saved;
  }, { timeout: 30_000 });
}
const checklistInclude = { items: { orderBy: { position: "asc" as const } } };
/** Called under the reservation lock. Only empty, unstarted assigned lists can be filled. */
export async function ensureChecklistSnapshot(tx: Prisma.TransactionClient, reservationId: string) {
  const existing = await tx.cleaningTaskChecklist.findUnique({ where: { reservationId }, include: checklistInclude });
  const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, select: { propertyId: true, status: true } });
  if (!reservation) throw new CleaningChecklistError("CLEANING_NOT_AVAILABLE", 404);
  if (existing) {
    if (existing.propertyId !== reservation.propertyId) throw new CleaningChecklistError("CHECKLIST_BINDING_CONFLICT");
    if (existing.items.length) return existing;
  }
  const [template, firstOffer, started] = await Promise.all([
    tx.cleaningChecklistTemplate.findUnique({ where: { propertyId: reservation.propertyId } }),
    tx.cleaningConfirmation.findFirst({ where: { reservationId, propertyId: reservation.propertyId, status: { in: ["PENDING", "CONFIRMED"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    tx.cleaningWork.findFirst({ where: { reservationId, OR: [{ startConfirmedAt: { not: null } }, { completionConfirmedAt: { not: null } }] }, select: { id: true } }),
  ]);
  const legacy = Boolean(started || !firstOffer || reservation.status !== "ACTIVE");
  const items = template && !legacy ? parseChecklistItems(template.items) : [];
  if (existing) {
    if (!items.length) return existing;
    return tx.cleaningTaskChecklist.update({ where: { id: existing.id }, data: {
      templateRevision: template!.revision, legacy: false,
      items: { create: items.map((item, position) => ({ templateKey: item.id, position, labelEs: item.es, labelEn: item.en, required: item.required })) },
    }, include: checklistInclude });
  }
  return tx.cleaningTaskChecklist.create({ data: { reservationId, propertyId: reservation.propertyId, templateRevision: template && !legacy ? template.revision : 0, legacy,
    items: { create: items.map((item, position) => ({ templateKey: item.id, position, labelEs: item.es, labelEn: item.en, required: item.required })) } }, include: checklistInclude });
}
export async function prepareChecklistSnapshot(db: PrismaClient, reservationId: string) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
    return ensureChecklistSnapshot(tx, reservationId);
  });
}
export async function assertChecklistComplete(tx: Prisma.TransactionClient, reservationId: string) {
  const checklist = await tx.cleaningTaskChecklist.findUnique({ where: { reservationId }, include: checklistInclude });
  if (checklist?.items.some(item => item.required && !item.checked)) throw new CleaningChecklistError("CHECKLIST_REQUIRED_ITEMS_PENDING");
}

async function ownOffer(tx: Prisma.TransactionClient, input: { confirmationId: string; staffMemberId: string; organizationId: string }) {
  const offer = await tx.cleaningConfirmation.findFirst({ where: { id: input.confirmationId, staffMemberId: input.staffMemberId, status: { in: ["PENDING", "CONFIRMED"] } } });
  const reservation = offer && await tx.reservation.findFirst({ where: { id: offer.reservationId, propertyId: offer.propertyId, property: { organizationId: input.organizationId } }, select: { id: true, status: true } });
  if (!offer || !reservation) throw new CleaningChecklistError("CLEANING_NOT_AVAILABLE", 404);
  const work = await tx.cleaningWork.findFirst({ where: { reservationId: offer.reservationId, propertyId: offer.propertyId, staffMemberId: input.staffMemberId, confirmationId: offer.id } });
  if (work?.cancelledAt || work?.supersededAt) throw new CleaningChecklistError("CLEANING_NOT_AVAILABLE", 404);
  return { offer, work, reservation };
}
export async function readOwnChecklist(db: PrismaClient, input: { confirmationId: string; staffMemberId: string; organizationId: string }) {
  return db.$transaction(async tx => {
    const pointer = await tx.cleaningConfirmation.findFirst({ where: { id: input.confirmationId, staffMemberId: input.staffMemberId }, select: { reservationId: true } });
    if (!pointer) throw new CleaningChecklistError("CLEANING_NOT_AVAILABLE", 404);
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${pointer.reservationId} FOR UPDATE`;
    const context = await ownOffer(tx, input);
    const checklist = await ensureChecklistSnapshot(tx, context.reservation.id);
    let editable = false;
    if (context.reservation.status === "ACTIVE" && context.work?.startConfirmedAt && !context.work.completionConfirmedAt) {
      try { assertCleaningActionTime(await readCleaningActionWindow(tx, context.work), "complete", new Date(), context.work.startConfirmedAt); editable = true; } catch { /* read-only when expired or unavailable */ }
    }
    return { ...checklist, editable };
  });
}
export async function setChecklistItem(db: PrismaClient, input: { confirmationId: string; staffMemberId: string; organizationId: string; itemId: string; checked: boolean; version: number }) {
  if (typeof input.checked !== "boolean" || !Number.isSafeInteger(input.version) || input.version < 0) throw new CleaningChecklistError("CHECKLIST_INVALID", 400);
  return db.$transaction(async tx => {
    const offer = await tx.cleaningConfirmation.findFirst({ where: { id: input.confirmationId, staffMemberId: input.staffMemberId }, select: { reservationId: true } });
    if (!offer) throw new CleaningChecklistError("CLEANING_NOT_AVAILABLE", 404);
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${offer.reservationId} FOR UPDATE`;
    const { work, reservation } = await ownOffer(tx, input);
    if (reservation.status !== "ACTIVE" || !work?.startConfirmedAt || work.completionConfirmedAt || !work.timingConsentAcceptedAt) throw new CleaningChecklistError("CHECKLIST_NOT_EDITABLE");
    assertCleaningActionTime(await readCleaningActionWindow(tx, work), "complete", new Date(), work.startConfirmedAt);
    const checklist = await ensureChecklistSnapshot(tx, work.reservationId);
    const item = checklist.items.find(candidate => candidate.id === input.itemId);
    if (!item) throw new CleaningChecklistError("CHECKLIST_ITEM_NOT_FOUND", 404);
    if (item.version !== input.version) throw new CleaningChecklistError("CHECKLIST_VERSION_CONFLICT");
    if (item.checked === input.checked) return item;
    const staff = await tx.staffMember.findUniqueOrThrow({ where: { id: input.staffMemberId } });
    const updated = await tx.cleaningTaskChecklistItem.update({ where: { id: item.id }, data: { checked: input.checked, checkedAt: input.checked ? new Date() : null, checkedByStaffMemberId: input.checked ? input.staffMemberId : null, version: { increment: 1 } } });
    await tx.cleaningChecklistItemEvent.create({ data: { checklistItemId: item.id, actorStaffMemberId: input.staffMemberId, actorName: staff.fullName, checked: input.checked } });
    return updated;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 });
}
