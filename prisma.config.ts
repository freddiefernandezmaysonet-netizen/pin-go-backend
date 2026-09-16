import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed/seed.ts",
  },
  experimental: {
    externalTables: true,
  },
  tables: {
    external: [
      "public.AuthFactor",
      "public.MfaChallenge",
      "public.SecurityEvent",
      "public.TrustedDevice",
      "public.AuthSession",
    ],
  },
  enums: {
    external: [
      "public.AuthFactorType",
      "public.AuthFactorStatus",
      "public.MfaChallengeStatus",
      "public.SecurityEventType",
    ],
  },
});
