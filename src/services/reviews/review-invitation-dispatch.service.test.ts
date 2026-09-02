import assert from "node:assert/strict";
import test from "node:test";
import { claimReviewInvitationDelivery } from "./review-invitation-dispatch.service.js";

function leaseStore(expiresAt: Date | null = null) {
  let leaseExpiresAt = expiresAt;
  let owner: string | null = null;
  return {
    client: { propertyReviewInvitation: { updateMany: async (query: any) => {
      const now = query.where.OR[1].deliveryLeaseExpiresAt.lte as Date;
      if (leaseExpiresAt && leaseExpiresAt > now) return { count: 0 };
      leaseExpiresAt = query.data.deliveryLeaseExpiresAt;
      owner = query.data.deliveryLeaseOwner;
      return { count: 1 };
    } } } as any,
    owner: () => owner,
  };
}

const claim = (client: any, owner: string, now: Date) => claimReviewInvitationDelivery({
  prisma: client,
  invitationId: "invitation-1",
  tokenHash: "a".repeat(64),
  recipientEmailHash: "b".repeat(64),
  now,
  leaseOwner: owner,
});

test("two workers competing at the same instant yield one lease winner", async () => {
  const store = leaseStore();
  const [first, second] = await Promise.all([
    claim(store.client, "worker-a", new Date("2026-09-02T12:00:00Z")),
    claim(store.client, "worker-b", new Date("2026-09-02T12:00:00Z")),
  ]);
  assert.deepEqual([first.count, second.count].sort(), [0, 1]);
  assert.equal(store.owner(), "worker-a");
});

test("a live lease blocks recovery while an expired lease is reclaimable", async () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const live = leaseStore(new Date("2026-09-02T12:01:00Z"));
  assert.equal((await claim(live.client, "worker-b", now)).count, 0);
  const expired = leaseStore(new Date("2026-09-02T11:59:00Z"));
  assert.equal((await claim(expired.client, "worker-b", now)).count, 1);
  assert.equal(expired.owner(), "worker-b");
});
