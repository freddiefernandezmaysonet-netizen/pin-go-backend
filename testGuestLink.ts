import { PrismaClient } from "@prisma/client";
import { sendGuestAccessLinkSms } from "./src/services/guestLinkSms.service.ts";

const prisma = new PrismaClient();

async function run() {
  const reservationId = "cmn6dtvj8000kn0pks96h24oy"; // 👈 pega uno de tu DB

  const res = await sendGuestAccessLinkSms(
    prisma,
    reservationId,
    "PAID"
  );

  console.log("RESULT:", res);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());