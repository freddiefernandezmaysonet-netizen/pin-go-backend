-- Additive only. Existing ACCEPTED responses are deliberately NOT backfilled.
CREATE TABLE "DamageCasePaymentAuthorization" (
    "id" TEXT NOT NULL,
    "damageCaseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "claimRevision" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "termsSnapshot" JSONB NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DamageCasePaymentAuthorization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DamageCasePaymentAuthorization_positive_amount" CHECK ("amountMinor" > 0),
    CONSTRAINT "DamageCasePaymentAuthorization_currency" CHECK ("currency" = 'usd'),
    CONSTRAINT "DamageCasePaymentAuthorization_version" CHECK ("version" = 'PROPERTY_PROTECTION_PAYMENT_AUTHORIZATION_V1'),
    CONSTRAINT "DamageCasePaymentAuthorization_action" CHECK ("action" = 'ACCEPT_AND_AUTHORIZE_PAYMENT'),
    CONSTRAINT "DamageCasePaymentAuthorization_language" CHECK ("language" IN ('en', 'es'))
);
CREATE UNIQUE INDEX "DamageCasePaymentAuthorization_damageCaseId_key" ON "DamageCasePaymentAuthorization"("damageCaseId");
CREATE INDEX "DamageCasePaymentAuthorization_organizationId_reservationId_idx" ON "DamageCasePaymentAuthorization"("organizationId", "reservationId");
ALTER TABLE "DamageCasePaymentAuthorization" ADD CONSTRAINT "DamageCasePaymentAuthorization_damageCaseId_fkey" FOREIGN KEY ("damageCaseId") REFERENCES "DamageCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
