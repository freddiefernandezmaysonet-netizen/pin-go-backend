import { ReviewPolicyError } from "./review-policy.js";

export type ReviewEligibleReservation = {
  source: string | null;
  externalProvider: string | null;
  status: string;
  cancelledAt: Date | null;
  paymentState: string;
  amountCollected?: unknown;
  checkOut: Date;
};

export function isCanonicalDirectBooking(reservation: Pick<ReviewEligibleReservation, "source" | "externalProvider">): boolean {
  return String(reservation.source ?? "").trim().toUpperCase() === "DIRECT_BOOKING" &&
    String(reservation.externalProvider ?? "").trim().toUpperCase() === "PIN_GO_DIRECT";
}

export function hasConfirmedDirectBookingPayment(reservation: Pick<ReviewEligibleReservation, "paymentState" | "amountCollected">): boolean {
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(String(reservation.paymentState)) &&
    Number(reservation.amountCollected ?? 0) > 0;
}

export function assertReviewStayEligible(reservation: ReviewEligibleReservation, options: { requireCheckoutCompleted: boolean; now: Date }): void {
  if (!isCanonicalDirectBooking(reservation)) throw new ReviewPolicyError("REVIEW_STAY_NOT_ELIGIBLE", "Only canonical Pin&Go direct stays are eligible.", 409);
  if (reservation.status !== "ACTIVE" || reservation.cancelledAt) throw new ReviewPolicyError("REVIEW_STAY_NOT_ELIGIBLE", "Cancelled stays are not eligible.", 409);
  if (!hasConfirmedDirectBookingPayment(reservation)) throw new ReviewPolicyError("REVIEW_STAY_NOT_ELIGIBLE", "The stay has no confirmed direct-booking payment.", 409);
  if (options.requireCheckoutCompleted && reservation.checkOut.getTime() > options.now.getTime()) throw new ReviewPolicyError("REVIEW_CHECKOUT_NOT_COMPLETED", "The stay has not completed.", 409);
}
