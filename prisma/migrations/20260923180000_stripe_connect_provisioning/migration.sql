CREATE TABLE "StripeConnectProvisioning" (
  "organizationId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'CLAIMED',
  "request" JSONB NOT NULL,
  "accountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StripeConnectProvisioning_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "StripeConnectProvisioning_state_check" CHECK ("state" IN ('CLAIMED', 'ACCOUNT_CREATED', 'ATTACHED', 'REVIEW_REQUIRED')),
  CONSTRAINT "StripeConnectProvisioning_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StripeConnectProvisioning_idempotencyKey_key" ON "StripeConnectProvisioning"("idempotencyKey");
CREATE UNIQUE INDEX "StripeConnectProvisioning_accountId_key" ON "StripeConnectProvisioning"("accountId");
