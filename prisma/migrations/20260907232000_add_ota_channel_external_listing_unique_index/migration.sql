-- Online uniqueness fence for a provider-scoped external listing identity.
-- This statement must remain outside an explicit transaction.
CREATE UNIQUE INDEX CONCURRENTLY "OtaChannelConnection_provider_externalListingId_key"
  ON "public"."OtaChannelConnection"("provider", "externalListingId");
