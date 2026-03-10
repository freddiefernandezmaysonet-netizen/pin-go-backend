import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@pingo.com";
  const password = "admin1234";
  const organizationId = "cmlk0fpl60000n0o0vo87t6tm"; // tu org actual dev

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await prisma.dashboardUser.findUnique({
    where: { email },
  });

  if (existing) {
    console.log("Admin already exists:", email);
    return;
  }

  const user = await prisma.dashboardUser.create({
    data: {
      email,
      passwordHash,
      fullName: "Pin&Go Admin",
      organizationId,
      role: "ADMIN",
    },
  });

  console.log("Admin created:");
  console.log({
    email,
    password,
    id: user.id,
  });
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });