import Stripe from "stripe";

const raw = process.env.STRIPE_SECRET_KEY;

if (!raw) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}

const key = raw.trim();

console.log("STRIPE KEY CHECK:", {
  prefix: key.slice(0, 10),  // sk_test_...
  len: key.length,
  hasStars: key.includes("*"),
  hasSpace: /\s/.test(raw),
});

const stripe = new Stripe(key, {
  apiVersion: "2023-10-16",
});

export default stripe;
