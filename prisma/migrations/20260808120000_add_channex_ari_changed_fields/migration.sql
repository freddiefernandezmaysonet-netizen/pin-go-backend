-- Pin&Go Distribution Engine — preserve semantic ARI deltas in the durable outbox.

BEGIN;

ALTER TABLE "DistributionOutboxEvent"
ADD COLUMN "changedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
