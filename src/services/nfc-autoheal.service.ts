import { prisma } from "../lib/prisma";
import { retryPendingNfcSync } from "./nfc-sync.service";

/** Uses the canonical lease, window and retry policy. Never resurrects ended
 * assignments or bypasses exhausted attempts. */
export async function healNfcAssignment(assignmentId: string) {
  const result = await retryPendingNfcSync(prisma, new Date(), { assignmentId });
  return { ok: result.activated > 0, assignmentId, ...result };
}
