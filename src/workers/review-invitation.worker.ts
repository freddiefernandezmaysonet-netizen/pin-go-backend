import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });
import { prisma } from "../lib/prisma.js";
import { reviewInvitationDispatcherEnabled } from "../config/reviews.config.js";
import { dispatchPostCheckoutReviewInvitations } from "../services/reviews/review-invitation-dispatch.service.js";

const pollMs = Math.max(Number(process.env.PINGO_REVIEW_INVITATION_POLL_MS ?? 300_000), 60_000);
let running = false;

async function tick() {
  if (running || !reviewInvitationDispatcherEnabled()) return;
  running = true;
  try {
    await dispatchPostCheckoutReviewInvitations({ prisma });
  } catch (error) {
    console.error("[REVIEW_INVITATION_DISPATCH_ERROR]", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    running = false;
  }
}

void tick();
const interval = setInterval(() => void tick(), pollMs);
async function shutdown() {
  clearInterval(interval);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
