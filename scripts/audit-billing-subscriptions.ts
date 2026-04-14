import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
const lockPriceId = String(process.env.STRIPE_PRICE_LOCK_MONTHLY ?? "").trim();
const smartPriceId = String(process.env.STRIPE_PRICE_SMART_PROPERTY ?? "").trim();

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY");
}

if (!lockPriceId) {
  throw new Error("Missing STRIPE_PRICE_LOCK_MONTHLY");
}

if (!smartPriceId) {
  throw new Error("Missing STRIPE_PRICE_SMART_PROPERTY");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-02-24.acacia",
});

type AuditRow = {
  organizationId: string;
  dbStripeSubscriptionId: string | null;
  dbStripeCustomerId: string | null;
  dbLockItemId: string | null;
  dbSmartItemId: string | null;
  dbEntitledLocks: number;
  dbEntitledSmartProperties: number;
  activeLocks: number;
  activeSmartProperties: number;

  stripeSubscriptionFound: boolean;
  stripeStatus: string | null;

  stripeLockItemId: string | null;
  stripeLockQty: number;
  stripeSmartItemId: string | null;
  stripeSmartQty: number;

  lockItemMatchesDb: boolean;
  smartItemMatchesDb: boolean;

  hasLockPrice: boolean;
  hasSmartPrice: boolean;

  issueCodes: string[];
};

async function main() {
  console.log("=== Billing audit start ===");

  const subscriptions = await prisma.subscription.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      organizationId: true,
      stripeSubscriptionId: true,
      stripeCustomerId: true,
      stripeSubscriptionItemId: true,
      stripeSmartSubscriptionItemId: true,
      entitledLocks: true,
      entitledSmartProperties: true,
      status: true,
    },
  });

  if (subscriptions.length === 0) {
    console.log("No subscriptions found in DB.");
    return;
  }

  const rows: AuditRow[] = [];

  for (const sub of subscriptions) {
    const activeLocks = await prisma.lock.count({
      where: {
        isActive: true,
        property: {
          organizationId: sub.organizationId,
        },
      },
    });

    const activeSmartProperties = await prisma.property.count({
      where: {
        organizationId: sub.organizationId,
        smartAutomationEnabled: true,
      },
    });

    const row: AuditRow = {
      organizationId: sub.organizationId,
      dbStripeSubscriptionId: sub.stripeSubscriptionId ?? null,
      dbStripeCustomerId: sub.stripeCustomerId ?? null,
      dbLockItemId: sub.stripeSubscriptionItemId ?? null,
      dbSmartItemId: sub.stripeSmartSubscriptionItemId ?? null,
      dbEntitledLocks: sub.entitledLocks ?? 0,
      dbEntitledSmartProperties: sub.entitledSmartProperties ?? 0,
      activeLocks,
      activeSmartProperties,

      stripeSubscriptionFound: false,
      stripeStatus: null,

      stripeLockItemId: null,
      stripeLockQty: 0,
      stripeSmartItemId: null,
      stripeSmartQty: 0,

      lockItemMatchesDb: false,
      smartItemMatchesDb: false,

      hasLockPrice: false,
      hasSmartPrice: false,

      issueCodes: [],
    };

    if (!sub.stripeSubscriptionId) {
      row.issueCodes.push("DB_SUBSCRIPTION_ID_MISSING");
      rows.push(row);
      continue;
    }

    try {
      const stripeSub = await stripe.subscriptions.retrieve(
        sub.stripeSubscriptionId,
        { expand: ["items.data.price"] }
      );

      row.stripeSubscriptionFound = true;
      row.stripeStatus = stripeSub.status;

      const items = stripeSub.items?.data ?? [];

      const lockItem =
        items.find((i: any) => i?.price?.id === lockPriceId) ?? null;

      const smartItem =
        items.find((i: any) => i?.price?.id === smartPriceId) ?? null;

      row.hasLockPrice = !!lockItem;
      row.hasSmartPrice = !!smartItem;

      row.stripeLockItemId = lockItem?.id ?? null;
      row.stripeLockQty = Number(lockItem?.quantity ?? 0);

      row.stripeSmartItemId = smartItem?.id ?? null;
      row.stripeSmartQty = Number(smartItem?.quantity ?? 0);

      row.lockItemMatchesDb =
        !!row.dbLockItemId && !!row.stripeLockItemId
          ? row.dbLockItemId === row.stripeLockItemId
          : false;

      row.smartItemMatchesDb =
        !!row.dbSmartItemId && !!row.stripeSmartItemId
          ? row.dbSmartItemId === row.stripeSmartItemId
          : false;

      if (!lockItem) {
        row.issueCodes.push("STRIPE_LOCK_ITEM_MISSING");
      }

      if (!smartItem) {
        row.issueCodes.push("STRIPE_SMART_ITEM_MISSING");
      }

      if (!row.dbLockItemId) {
        row.issueCodes.push("DB_LOCK_ITEM_ID_MISSING");
      }

      if (!row.dbSmartItemId) {
        row.issueCodes.push("DB_SMART_ITEM_ID_MISSING");
      }

      if (lockItem && row.dbLockItemId && !row.lockItemMatchesDb) {
        row.issueCodes.push("LOCK_ITEM_ID_MISMATCH");
      }

      if (smartItem && row.dbSmartItemId && !row.smartItemMatchesDb) {
        row.issueCodes.push("SMART_ITEM_ID_MISMATCH");
      }

      if (
        row.dbLockItemId &&
        row.dbSmartItemId &&
        row.dbLockItemId === row.dbSmartItemId
      ) {
        row.issueCodes.push("DB_LOCK_AND_SMART_ITEM_SAME");
      }

      if (
        row.stripeLockItemId &&
        row.stripeSmartItemId &&
        row.stripeLockItemId === row.stripeSmartItemId
      ) {
        row.issueCodes.push("STRIPE_LOCK_AND_SMART_ITEM_SAME");
      }

      if (row.dbEntitledLocks !== row.stripeLockQty) {
        row.issueCodes.push("DB_LOCK_QTY_DIFFERS_FROM_STRIPE");
      }

      if (row.dbEntitledSmartProperties !== row.stripeSmartQty) {
        row.issueCodes.push("DB_SMART_QTY_DIFFERS_FROM_STRIPE");
      }

      if (row.dbEntitledLocks < row.activeLocks) {
        row.issueCodes.push("DB_LOCKS_BELOW_ACTIVE_LOCKS");
      }

      if (row.dbEntitledSmartProperties < row.activeSmartProperties) {
        row.issueCodes.push("DB_SMART_BELOW_ACTIVE_SMART");
      }
    } catch (err: any) {
      row.issueCodes.push(`STRIPE_RETRIEVE_FAILED:${err?.message ?? "unknown"}`);
    }

    rows.push(row);
  }

  console.log("");
  console.log("=== Billing audit report ===");
  console.log("");

  for (const row of rows) {
    console.log("------------------------------------------------------------");
    console.log("ORG:", row.organizationId);
    console.log("DB subscription:", row.dbStripeSubscriptionId);
    console.log("DB customer:", row.dbStripeCustomerId);
    console.log("DB lock item:", row.dbLockItemId);
    console.log("DB smart item:", row.dbSmartItemId);
    console.log("DB entitled locks:", row.dbEntitledLocks);
    console.log("DB entitled smart:", row.dbEntitledSmartProperties);
    console.log("Active locks:", row.activeLocks);
    console.log("Active smart properties:", row.activeSmartProperties);
    console.log("Stripe found:", row.stripeSubscriptionFound);
    console.log("Stripe status:", row.stripeStatus);
    console.log("Stripe lock item:", row.stripeLockItemId);
    console.log("Stripe lock qty:", row.stripeLockQty);
    console.log("Stripe smart item:", row.stripeSmartItemId);
    console.log("Stripe smart qty:", row.stripeSmartQty);
    console.log("Lock item matches DB:", row.lockItemMatchesDb);
    console.log("Smart item matches DB:", row.smartItemMatchesDb);
    console.log(
      "Issues:",
      row.issueCodes.length > 0 ? row.issueCodes.join(", ") : "NONE"
    );
  }

  console.log("");
  console.log("=== Summary ===");

  const withIssues = rows.filter((r) => r.issueCodes.length > 0);
  console.log(`Total orgs audited: ${rows.length}`);
  console.log(`Orgs with issues: ${withIssues.length}`);

  if (withIssues.length > 0) {
    console.log("");
    console.log("Problem orgs:");
    for (const row of withIssues) {
      console.log(
        `- ${row.organizationId}: ${row.issueCodes.join(", ")}`
      );
    }
  }

  console.log("");
  console.log("=== Billing audit end ===");
}

main()
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });