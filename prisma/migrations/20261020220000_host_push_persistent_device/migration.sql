-- Existing registrations keep their expiry. Only an authenticated, capable client
-- may register a persistent binding; this migration does not revive any device.
ALTER TABLE "HostMobilePushDevice" ALTER COLUMN "expiresAt" DROP NOT NULL;
