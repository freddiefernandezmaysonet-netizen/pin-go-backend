import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("CWD =", process.cwd());
  console.log("ACCESS_GRANT_ID =", process.env.ACCESS_GRANT_ID);

  const id = process.env.ACCESS_GRANT_ID;
  if (!id) {
    throw new Error("ACCESS_GRANT_ID no está definido en .env");
  }

  const grant = await prisma.accessGrant.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      method: true,
      ttlockKeyboardPwdId: true,
      ttlockKeyId: true,
    },
  });

  console.log("DB RESULT =", grant);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
