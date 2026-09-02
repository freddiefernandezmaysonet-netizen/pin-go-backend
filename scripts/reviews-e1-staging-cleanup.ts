import { PrismaClient } from "@prisma/client";

const STAGING_PROJECT_ID = "c325f65b-f4a5-48a9-9270-376961eeba2d";

if (process.env.RAILWAY_PROJECT_ID !== STAGING_PROJECT_ID) {
  throw new Error("Reviews cleanup refused outside the isolated staging project.");
}

const prisma = new PrismaClient();

try {
  await prisma.dashboardUser.updateMany({
    where: { email: "reviews-admin@pin-go.invalid" },
    data: { isActive: false, tokenVersion: { increment: 1 } },
  });
} finally {
  await prisma.$disconnect();
}
