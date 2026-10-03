import type Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { isStayTimeModification } from "./stay-time-apply-validation.service.js";
import { processStayTimePayment } from "./stay-time-payment-flow.service.js";

type Dependencies = {
  client: Pick<PrismaClient, "reservationModification">;
  processPayment: (scope: Parameters<typeof processStayTimePayment>[0]) => ReturnType<typeof processStayTimePayment>;
};

/** Only call after Stripe signature verification. The signed event account, not
 * metadata alone, establishes the Connect scope. Provider evidence is retrieved
 * again by the payment processor before any application or recovery. */
export async function handleStayTimePaymentEvent(event: Stripe.Event, deps: Dependencies) {
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return { handled: false as const };
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.metadata?.flow !== "direct_booking_reservation_modification") return { handled: false as const };
  const modificationId = session.metadata.reservationModificationId;
  if (!modificationId) return { handled: false as const };
  const modification = await deps.client.reservationModification.findUnique({
    where: { id: modificationId },
    select: { id: true, requestSource: true, guestConfirmation: true, stripeConnectedAccountId: true, stripeCheckoutSessionId: true },
  });
  if (!modification || !isStayTimeModification(modification.guestConfirmation)) return { handled: false as const };
  if (modification.requestSource !== "PIN_AI_GUEST_SERVICES" ||
      !event.account || event.account !== modification.stripeConnectedAccountId ||
      session.metadata.connectedAccountId !== event.account ||
      session.id !== modification.stripeCheckoutSessionId || session.client_reference_id !== modification.id ||
      session.object !== "checkout.session" || session.mode !== "payment" ||
      typeof event.livemode !== "boolean" || session.livemode !== event.livemode) {
    throw new Error("STAY_TIME_PAYMENT_EVENT_SCOPE_MISMATCH");
  }
  if (session.payment_status !== "paid") return { handled: true as const, outcome: "PAYMENT_PENDING" as const };
  const result = await deps.processPayment({ modificationId, checkoutSessionId: session.id, connectedAccountId: event.account });
  // Keep the financial event retryable until recovery is settled. A future
  // durable worker can also resume the same persisted refund journal.
  if (result.outcome === "REFUND_PENDING") throw new Error("STAY_TIME_PAYMENT_RECOVERY_PENDING");
  return { handled: true as const, ...result };
}
