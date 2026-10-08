-- CreateTable
CREATE TABLE "CleaningChecklistTemplate" (
    "propertyId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleaningChecklistTemplate_pkey" PRIMARY KEY ("propertyId")
);

-- CreateTable
CREATE TABLE "CleaningTaskChecklist" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "templateRevision" INTEGER NOT NULL,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleaningTaskChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleaningTaskChecklistItem" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "labelEs" VARCHAR(500) NOT NULL,
    "labelEn" VARCHAR(500) NOT NULL,
    "required" BOOLEAN NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3),
    "checkedByStaffMemberId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CleaningTaskChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleaningChecklistItemEvent" (
    "id" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "actorStaffMemberId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleaningChecklistItemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CleaningTaskChecklist_reservationId_key" ON "CleaningTaskChecklist"("reservationId");

-- CreateIndex
CREATE INDEX "CleaningTaskChecklist_propertyId_idx" ON "CleaningTaskChecklist"("propertyId");

-- CreateIndex
CREATE INDEX "CleaningTaskChecklistItem_checklistId_position_idx" ON "CleaningTaskChecklistItem"("checklistId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CleaningTaskChecklistItem_checklistId_templateKey_key" ON "CleaningTaskChecklistItem"("checklistId", "templateKey");

-- CreateIndex
CREATE INDEX "CleaningChecklistItemEvent_checklistItemId_createdAt_idx" ON "CleaningChecklistItemEvent"("checklistItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "CleaningChecklistTemplate" ADD CONSTRAINT "CleaningChecklistTemplate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningTaskChecklist" ADD CONSTRAINT "CleaningTaskChecklist_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningTaskChecklist" ADD CONSTRAINT "CleaningTaskChecklist_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningTaskChecklistItem" ADD CONSTRAINT "CleaningTaskChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "CleaningTaskChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningChecklistItemEvent" ADD CONSTRAINT "CleaningChecklistItemEvent_checklistItemId_fkey" FOREIGN KEY ("checklistItemId") REFERENCES "CleaningTaskChecklistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
