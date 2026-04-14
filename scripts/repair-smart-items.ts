import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-02-24.acacia",
});

const smartPriceId = process.env.STRIPE_PRICE_SMART_PROPERTY!;

async function main() {
  console.log("🔧 Repairing SMART items...");

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

    const smartItem = items.find(
      (i: any) => i.price.id === smartPriceId
    );

    if (smartItem) {
      console.log("✅ Smart item already exists:", smartItem.id);
      continue;
    }

    console.log("⚠️ Smart item missing → creating...");

    const activeSmartProperties = await prisma.property.count({
      where: {
        organizationId: sub.organizationId,
        smartAutomationEnabled: true,
      },
    });

    const quantity = Math.max(
      activeSmartProperties,
      sub.entitledSmartProperties || 0
    );

    const updated = await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      {
        items: [
          ...items.map((i: any) => ({
            id: i.id,
            quantity: i.quantity,
          })),
          {
            price: smartPriceId,
            quantity,
          },
        ],
        proration_behavior: "none",
      }
    );

    const newSmartItem = updated.items.data.find(
      (i: any) => i.price.id === smartPriceId
    );

    console.log("✅ Created smart item:", newSmartItem?.id);

    await prisma.subscription.update({
      where: { organizationId: sub.organizationId },
      data: {
        stripeSmartSubscriptionItemId: newSmartItem?.id ?? null,
      },
    });

    console.log("✅ DB updated");
  }

  console.log("\n🎉 SMART repair complete");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());