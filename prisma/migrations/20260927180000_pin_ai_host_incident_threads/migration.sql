-- CreateTable
CREATE TABLE "PinAIHostIncidentThread" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinAIHostIncidentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinAIHostIncidentMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinAIHostIncidentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PinAIHostIncidentThread_issueId_key" ON "PinAIHostIncidentThread"("issueId");

-- CreateIndex
CREATE INDEX "PinAIHostIncidentThread_organizationId_updatedAt_idx" ON "PinAIHostIncidentThread"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "PinAIHostIncidentThread_reservationId_idx" ON "PinAIHostIncidentThread"("reservationId");

-- CreateIndex
CREATE INDEX "PinAIHostIncidentMessage_threadId_audience_sequence_idx" ON "PinAIHostIncidentMessage"("threadId", "audience", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PinAIHostIncidentMessage_threadId_requestId_key" ON "PinAIHostIncidentMessage"("threadId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PinAIHostIncidentMessage_threadId_sequence_key" ON "PinAIHostIncidentMessage"("threadId", "sequence");

-- AddForeignKey
ALTER TABLE "PinAIHostIncidentThread" ADD CONSTRAINT "PinAIHostIncidentThread_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "OperationalIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinAIHostIncidentMessage" ADD CONSTRAINT "PinAIHostIncidentMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PinAIHostIncidentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

