-- CreateTable
CREATE TABLE "public"."PrimeNotifyState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lastNotified" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrimeNotifyState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrimeNotifyState_organizationId_key" ON "public"."PrimeNotifyState"("organizationId");
