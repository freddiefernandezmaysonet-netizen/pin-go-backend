import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-02-24.acacia",
});

const lockPriceId = process.env.STRIPE_PRICE_LOCK_MONTHLY!;

async function main() {
  console.log("🔧 Repairing lock items...");

  const subs = await prisma.subscription.findMany();

  for (const sub of subs) {
    if (!sub.stripeSubscriptionId) continue;

    console.log("\n--------------------------------");
    console.log("ORG:", sub.organizationId);

    const stripeSub = await stripe.subscriptions.retrieve(
      sub.stripeSubscriptionId,
      { expand: ["items.data.price"] }
    );

    const items = stripeSub.items.data;

    const lockItem = items.find(
      (i: any) => i.price.id === lockPriceId
    );

    if (lockItem) {
      console.log("✅ Lock item already exists:", lockItem.id);
      continue;
    }

    console.log("⚠️ Lock item missing → creating...");

    const activeLocks = await prisma.lock.count({
      where: {
        isActive: true,
        property: {
          organizationId: sub.organizationId,
        },
      },
    });

    const quantity = Math.max(activeLocks, sub.entitledLocks || 1);

    const updated = await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      {
        items: [
          ...items.map((i: any) => ({
            id: i.id,
            quantity: i.quantity,
          })),
          {
            price: lockPriceId,
            quantity,
          },
        ],
        proration_behavior: "none",
      }
    );

    const newLockItem = updated.items.data.find(
      (i: any) => i.price.id === lockPriceId
    );

    console.log("✅ Created lock item:", newLockItem?.id);

    await prisma.subscription.update({
      where: { organizationId: sub.organizationId },
      data: {
        stripeSubscriptionItemId: newLockItem?.id ?? null,
      },
    });

    console.log("✅ DB updated");
  }

  console.log("\n🎉 Repair complete");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());