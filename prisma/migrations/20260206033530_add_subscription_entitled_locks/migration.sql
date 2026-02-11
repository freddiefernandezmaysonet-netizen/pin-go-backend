-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "entitledLocks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeSubscriptionItemId" TEXT;
