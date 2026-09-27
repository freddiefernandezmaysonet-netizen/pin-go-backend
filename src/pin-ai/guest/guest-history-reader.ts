import type { PrismaClient } from "@prisma/client";
import type { PinAIActionBrokerExecuteResult } from "../actions/action-broker.service.js";
import { openGuestHistory, readGuestMessages, type GuestHistoryMessage } from "./guest-history.js";

type HistoryPrisma = Pick<PrismaClient, "pinAIGuestConversation" | "pinAIActionProposal" | "reservationModification">;

export async function readGuestHistory(prisma: HistoryPrisma, scope: {
  guestToken: string; reservationId: string; propertyId: string; organizationId: string;
}, now: Date): Promise<GuestHistoryMessage[]> {
  const row = await prisma.pinAIGuestConversation.findUnique({
    where: { reservationId: scope.reservationId },
    select: { guestHistoryCiphertext: true, guestActionReceiptsCiphertext: true },
  });
  const messages = readGuestMessages(scope, row?.guestHistoryCiphertext);
  const receipts = row?.guestActionReceiptsCiphertext
    ? openGuestHistory<PinAIActionBrokerExecuteResult[]>(scope, "receipts", row.guestActionReceiptsCiphertext) : [];
  if (!Array.isArray(receipts) || receipts.length > 20) throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
  return Promise.all(messages.map(async message => {
    const p = message.actionProposal;
    if (!p) return message;
    const proposal = await prisma.pinAIActionProposal.findFirst({
      where: { id: p.proposalId, reservationId: scope.reservationId, propertyId: scope.propertyId,
        organizationId: scope.organizationId, actionType: "RESERVATION_MODIFICATION" },
      select: { id: true, status: true },
    });
    const modification = proposal ? await prisma.reservationModification.findFirst({
      where: { reservationId: scope.reservationId, clientRequestId: `pin_ai_${proposal.id}`, requestSource: "PIN_AI_GUEST_SERVICES" },
      select: { id: true, status: true, stripePaymentStatus: true, checkoutExpiresAt: true, appliedAt: true },
    }) : null;
    if (proposal?.status === "PENDING_CONFIRMATION" && !modification) return message;
    const saved = receipts.find(r => r.proposalId === p.proposalId && r.modificationId === modification?.id);
    const applied = modification?.status === "APPLIED" && Boolean(modification.appliedAt);
    const payable = proposal?.status === "CONFIRMED" && modification?.status === "AWAITING_PAYMENT" &&
      modification.stripePaymentStatus === "unpaid" && Boolean(modification.checkoutExpiresAt && modification.checkoutExpiresAt > now);
    const processing = modification && (["PAYMENT_PROCESSING", "APPLYING"].includes(modification.status) ||
      (modification.status === "AWAITING_PAYMENT" && modification.stripePaymentStatus === "paid"));
    const host = modification?.status === "HOST_APPROVAL_REQUIRED";
    const actionResult: PinAIActionBrokerExecuteResult = {
      ok: true, actionType: "RESERVATION_MODIFICATION", proposalId: p.proposalId,
      outcome: applied ? "EXECUTED" : host ? "WAITING_FOR_HOST" : payable || processing ? "WAITING_FOR_PAYMENT" : "REVIEW_REQUIRED",
      actionExecuted: applied, quoteExpiresAt: p.quote.quoteExpiresAt, quoteExpiresAtLocal: p.quote.quoteExpiresAtLocal,
      propertyTimezone: p.quote.propertyTimezone, availabilityHeld: false,
      modificationId: modification?.id ?? null, modificationStatus: processing ? "PAYMENT_PROCESSING" : modification?.status ?? null,
      // Only the URL actually returned by an explicit confirmation can be resumed.
      // Read-only history never creates or retrieves a provider checkout.
      checkoutUrl: payable && typeof saved?.checkoutUrl === "string" && saved.checkoutUrl.startsWith("https://") ? saved.checkoutUrl : null,
      paymentExpiresAt: modification?.checkoutExpiresAt ?? null, amountDifference: p.quote.amountDifference,
      amountDifferenceCents: p.quote.amountDifferenceCents, currency: p.quote.currency,
      reasonCode: payable && !saved?.checkoutUrl ? "PAYMENT_LINK_UNAVAILABLE" : null,
    };
    return { ...message, actionResult };
  }));
}
