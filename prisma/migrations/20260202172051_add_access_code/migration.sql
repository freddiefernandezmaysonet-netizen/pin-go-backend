-- CreateTable
CREATE TABLE "AccessCode" (
    "id" TEXT NOT NULL,
    "lockId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "keyboardPwdId" TEXT,
    "startDate" BIGINT NOT NULL,
    "endDate" BIGINT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessCode_lockId_createdAt_idx" ON "AccessCode"("lockId", "createdAt");
