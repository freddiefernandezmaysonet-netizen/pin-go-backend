-- CreateTable
CREATE TABLE "public"."MessageLog" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "from" TEXT,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" TEXT,
    "accessGrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageLog_channel_to_createdAt_idx" ON "public"."MessageLog"("channel", "to", "createdAt");

-- CreateIndex
CREATE INDEX "MessageLog_accessGrantId_idx" ON "public"."MessageLog"("accessGrantId");

-- AddForeignKey
ALTER TABLE "public"."MessageLog" ADD CONSTRAINT "MessageLog_accessGrantId_fkey" FOREIGN KEY ("accessGrantId") REFERENCES "public"."AccessGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
