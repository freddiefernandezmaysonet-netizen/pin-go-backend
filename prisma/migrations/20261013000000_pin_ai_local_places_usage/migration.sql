CREATE TABLE "PinAILocalPlacesUsageBucket" (
  "monthKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PinAILocalPlacesUsageBucket_pkey" PRIMARY KEY ("monthKey"),
  CONSTRAINT "PinAILocalPlacesUsageBucket_attempts_nonnegative" CHECK ("attempts" >= 0)
);
