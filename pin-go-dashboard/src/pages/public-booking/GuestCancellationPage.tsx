import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE ||
  "https://api.pin-ngo.com";

type CancellationRefundRule = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
  label: string;
  description?: string | null;
};

type CancellationPreviewResponse = {
  ok?: boolean;
  alreadyCancelled?: boolean;
  reservation?: {
    reservationNumber?: string | null;
    propertyName?: string | null;
    guestName?: string | null;
    guestEmail?: string | null;
    checkIn: string;
    checkOut: string;
    status: string;
    paymentState: string;
    totalAmount?: number | null;
    currency?: string | null;
    cancelledAt?: string | null;
  };
  policy?: {
    name: string;
    type: string;
    refundBasis: string;
    refundRules: CancellationRefundRule[];
    nonRefundableScenarios: string[];
    guestFacingSummary?: string | null;
    cancellationTermsAcceptance?: {
      text?: string | null;
      source?: string | null;
      version?: string | null;
      accepted?: boolean | null;
      acceptedAt?: string | null;
      refundBasis?: string | null;
    } | null;
  };
  evaluation?: {
    requestedAt: string;
    checkIn: string;
    freeCancellationDeadline: string;
    hoursBeforeCheckIn: number;
    beforeDeadline: boolean;
    refundPercent: number;
    refundAmount: number;
    refundAmountCents: number;
    usesTieredRules: boolean;
    matchedRefundRule?: CancellationRefundRule | null;
    eligibleForGuestSelfCancellation: boolean;
    eligibleForAutoRefund: boolean;
    requiresHostApproval: boolean;
    reason: string;
    breakdown?: {
      totalAmount: number;
      totalAmountCents: number;
      nightlySubtotal: number;
      nightlySubtotalCents: number;
      cleaningFee: number;
      cleaningFeeCents: number;
      amenitiesTotal: number;
      amenitiesTotalCents: number;
      taxesTotal: number;
      taxesTotalCents: number;
      refundableBase: number;
      refundableBaseCents: number;
    } | null;
  };
  action?: string;
  refundExecution?: string;
  refund?: {
    stripeRefundId?: string | null;
    status?: string | null;
    amount?: number | null;
    amountCents?: number | null;
    currency?: string | null;
    reason?: string | null;
    refundMode?: string | null;
    refundPercent?: number | null;
    isFullRefund?: boolean | null;
    refundedAt?: string | null;
  } | null;
  error?: string;
  message?: string;
  details?: CancellationPreviewResponse;
};

function formatMoney(value: number | null | undefined, currency = "usd") {
  const amount = Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not available";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRefundBasis(value: string | null | undefined) {
  if (value === "NIGHTLY_SUBTOTAL") {
    return "Nightly subtotal only";
  }

  if (value === "NIGHTLY_PLUS_CLEANING") {
    return "Nightly subtotal + cleaning fee";
  }

  if (value === "CUSTOM") {
    return "Custom refundable base";
  }

  return "Total reservation amount";
}

function formatScenario(value: string) {
  if (value === "EARLY_DEPARTURE") return "Early departures";
  if (value === "DELAYED_ARRIVAL") return "Delayed arrivals";
  if (value === "REDUCED_NIGHTS") return "Reducing reserved nights";
  if (value === "WEATHER_RE_SCHEDULE") return "Weather-related reschedules";
  return "Other post-booking changes";
}

function getEffectiveRefundExecution(
  preview: CancellationPreviewResponse | null | undefined
) {
  if (preview?.refundExecution) {
    return preview.refundExecution;
  }

  if (preview?.reservation?.paymentState === "REFUNDED") {
    return "FULL_REFUND_EXECUTED";
  }

  if (preview?.reservation?.paymentState === "PARTIALLY_REFUNDED") {
    return "PARTIAL_REFUND_EXECUTED";
  }

  return null;
}

function getDisplayedRefundAmount(
  preview: CancellationPreviewResponse | null | undefined
) {
  const refundAmountCents = Number(preview?.refund?.amountCents ?? NaN);

  if (Number.isFinite(refundAmountCents) && refundAmountCents >= 0) {
    return refundAmountCents / 100;
  }

  const refundAmount = Number(preview?.refund?.amount ?? NaN);

  if (Number.isFinite(refundAmount) && refundAmount >= 0) {
    return refundAmount;
  }

  return Number(preview?.evaluation?.refundAmount ?? 0);
}

function getRefundAmountLabel(
  preview: CancellationPreviewResponse | null | undefined
) {
  const refundExecution = getEffectiveRefundExecution(preview);

  if (refundExecution === "FULL_REFUND_EXECUTED") {
    return "Refund processed";
  }

  if (refundExecution === "PARTIAL_REFUND_EXECUTED") {
    return "Partial refund processed";
  }

  if (
    refundExecution === "NO_REFUND_DUE" ||
    preview?.reservation?.paymentState === "REFUNDED" ||
    preview?.reservation?.status === "CANCELLED"
  ) {
    return Number(preview?.evaluation?.refundAmountCents ?? 0) > 0
      ? "Refund amount"
      : "No refund due";
  }

  return "Estimated refund";
}

function getActionCopy(preview: CancellationPreviewResponse | null) {
  const refundExecution = getEffectiveRefundExecution(preview);

  if (refundExecution === "FULL_REFUND_EXECUTED") {
    return {
      title: "Refund processed",
      text:
        "Pin&Go cancelled the reservation and submitted the eligible refund through Stripe.",
    };
  }

  if (refundExecution === "PARTIAL_REFUND_EXECUTED") {
    return {
      title: "Partial refund processed",
      text:
        "Pin&Go cancelled the reservation and submitted the eligible partial refund through Stripe. Non-refundable charges were handled according to the cancellation terms accepted at booking.",
    };
  }

  if (refundExecution === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return {
      title: "Cancellation recorded",
      text:
        "The reservation was cancelled. The eligible refund still needs to be handled by the property workflow.",
    };
  }

  if (refundExecution === "GUEST_AUTO_REFUND_FAILED") {
    return {
      title: "Refund needs review",
      text:
        "The cancellation request was recorded, but the automatic refund could not be completed and needs review.",
    };
  }

  if (preview?.action === "HOST_APPROVAL_REQUIRED") {
    return {
      title: "Host approval required",
      text:
        "This cancellation cannot be completed automatically. Pin&Go can record the request for host review.",
    };
  }

  if (preview?.action === "CANCELLATION_ALLOWED_REFUND_PENDING") {
    return {
      title: "Cancellation allowed",
      text:
        "This cancellation is allowed under the policy. The eligible refund is estimated below and may be submitted through Stripe when you confirm.",
    };
  }

  if (preview?.action === "CANCELLATION_ALLOWED_NO_REFUND") {
    return {
      title: "Cancellation allowed with no refund",
      text:
        "This cancellation is allowed under the policy, but no refund is estimated for the selected stay.",
    };
  }

  return {
    title: "Cancellation review",
    text:
      "Pin&Go will evaluate the reservation policy before completing this cancellation.",
  };
}

function getRefundExecutionCopy(
  preview: CancellationPreviewResponse | null | undefined,
  currency: string
) {
  const value = getEffectiveRefundExecution(preview);
  const amount = formatMoney(getDisplayedRefundAmount(preview), currency);

  if (value === "FULL_REFUND_EXECUTED") {
    return `Your eligible refund of ${amount} was submitted through Stripe.`;
  }

  if (value === "PARTIAL_REFUND_EXECUTED") {
    return `Your eligible partial refund of ${amount} was submitted through Stripe. Any non-refundable charges remain subject to the cancellation terms accepted at booking.`;
  }

  if (value === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return "Your cancellation was recorded. The eligible refund is pending the property refund workflow.";
  }

  if (value === "NOT_EXECUTED_HOST_APPROVAL_REQUIRED") {
    return "This cancellation requires host approval before any refund can be processed.";
  }

  if (value === "GUEST_AUTO_REFUND_FAILED") {
    return "Pin&Go could not complete the automatic refund. The cancellation request was recorded for review.";
  }

  if (value === "REFUND_NOT_EXECUTED_IN_V1") {
    return "Refund has not been processed yet. Pin&Go will follow the property cancellation workflow.";
  }

  if (value === "NO_REFUND_DUE") {
    return "No refund is due according to the current policy evaluation.";
  }

  return "Refund execution will follow the property cancellation workflow.";
}

function getCancellationSubmitMessage(preview: CancellationPreviewResponse) {
  const refundExecution = getEffectiveRefundExecution(preview);

  if (preview.alreadyCancelled) {
    return "This reservation was already cancelled.";
  }

  if (refundExecution === "FULL_REFUND_EXECUTED") {
    return "Your reservation was cancelled and your eligible refund was submitted through Stripe.";
  }

  if (refundExecution === "PARTIAL_REFUND_EXECUTED") {
    return "Your reservation was cancelled and your eligible partial refund was submitted through Stripe.";
  }

  if (refundExecution === "NO_REFUND_DUE") {
    return "Your reservation was cancelled. No refund is due according to the policy.";
  }

  if (refundExecution === "REFUND_PENDING_PROPERTY_WORKFLOW") {
    return "Your reservation was cancelled. The refund remains pending in the property workflow.";
  }

  return "Your reservation cancellation was recorded by Pin&Go.";
}

function getConfirmationCopy(preview: CancellationPreviewResponse | null) {
  if (preview?.evaluation?.requiresHostApproval) {
    return "I understand that this action will request cancellation review from the host and may not cancel my reservation immediately.";
  }

  if (
    preview?.evaluation?.eligibleForAutoRefund &&
    Number(preview.evaluation.refundAmountCents ?? 0) > 0
  ) {
    return "I understand that this action may cancel my reservation and Pin&Go may submit any eligible refund through Stripe according to the cancellation terms accepted at booking.";
  }

  if (Number(preview?.evaluation?.refundAmountCents ?? 0) <= 0) {
    return "I understand that this action may cancel my reservation and no refund is currently estimated under the accepted cancellation terms.";
  }

  return "I understand that this action may cancel my reservation and that any eligible refund will follow the property cancellation workflow.";
}

function getErrorMessage(payload: CancellationPreviewResponse) {
  return (
    payload.message ||
    payload.error ||
    "Unable to complete this cancellation request."
  );
}

function getPreviewPayload(payload: CancellationPreviewResponse) {
  if (payload.details?.reservation && payload.details?.evaluation) {
    return payload.details;
  }

  return payload;
}

export default function GuestCancellationPage() {
  const { guestToken } = useParams();

  const [preview, setPreview] = useState<CancellationPreviewResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      setLoading(true);
      setPageError(null);
      setSubmitMessage(null);

      const token = String(guestToken ?? "").trim();

      if (!token) {
        throw new Error("Missing reservation link.");
      }

      const res = await fetch(
        `${API_BASE}/api/public-booking/manage/${encodeURIComponent(
          token
        )}/cancellation-preview`
      );

      const data: CancellationPreviewResponse = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(getErrorMessage(data));
      }

      setPreview(data);
    } catch (err: any) {
      setPageError(err?.message || "Unable to load this reservation.");
    } finally {
      setLoading(false);
    }
  }, [guestToken]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const currency = preview?.reservation?.currency || "usd";

  const isCancelled =
    preview?.reservation?.status === "CANCELLED" ||
    Boolean(preview?.reservation?.cancelledAt);

  const actionCopy = useMemo(() => getActionCopy(preview), [preview]);

  const displayedRefundAmount = getDisplayedRefundAmount(preview);
  const refundAmountLabel = getRefundAmountLabel(preview);
  const confirmationCopy = getConfirmationCopy(preview);

  const canSubmit = Boolean(preview && !isCancelled && accepted && !submitting);

  async function handleSubmitCancellation() {
    try {
      setSubmitting(true);
      setPageError(null);
      setSubmitMessage(null);

      const token = String(guestToken ?? "").trim();

      if (!token) {
        throw new Error("Missing reservation link.");
      }

      if (!accepted) {
        throw new Error("Please confirm that you understand this cancellation.");
      }

      const res = await fetch(
        `${API_BASE}/api/public-booking/manage/${encodeURIComponent(
          token
        )}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: reason.trim() || null,
          }),
        }
      );

      const data: CancellationPreviewResponse = await res.json();
      const nextPreview = getPreviewPayload(data);

      if (!res.ok || !data.ok) {
        if (
          data.error === "CANCELLATION_REQUIRES_HOST_APPROVAL" &&
          nextPreview.reservation
        ) {
          setPreview(nextPreview);
          setSubmitMessage(
            "Your cancellation request was recorded and requires host approval."
          );
          setAccepted(false);
          return;
        }

        throw new Error(getErrorMessage(data));
      }

      setPreview(nextPreview);
      setSubmitMessage(getCancellationSubmitMessage(nextPreview));
      setAccepted(false);
    } catch (err: any) {
      setPageError(err?.message || "Unable to submit cancellation request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <Link to="/home" style={styles.brandWrap}>
            <img
              src="/pin-go-logo.png"
              alt="Pin&Go logo"
              style={styles.logo}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <div>
              <div style={styles.brandName}>Pin&Go</div>
              <div style={styles.slogan}>Manage reservation</div>
            </div>
          </Link>
        </div>
      </header>

      <main style={styles.main}>
        <section style={styles.hero}>
          <div style={styles.container}>
            <div style={styles.badge}>Guest Cancellation Portal</div>
            <h1 style={styles.title}>Review your cancellation options</h1>
            <p style={styles.subtitle}>
              Pin&Go uses the cancellation terms accepted at booking time to
              estimate eligibility before the reservation is cancelled.
            </p>
          </div>
        </section>

        <section style={styles.contentSection}>
          <div style={styles.container}>
            {loading ? (
              <div style={styles.card}>
                <div style={styles.loadingTitle}>Loading reservation...</div>
                <p style={styles.mutedText}>
                  Please wait while Pin&Go checks the reservation policy.
                </p>
              </div>
            ) : pageError && !preview ? (
              <div style={styles.errorCard}>
                <strong>Unable to load reservation</strong>
                <p>{pageError}</p>
                <button type="button" style={styles.secondaryButton} onClick={loadPreview}>
                  Try again
                </button>
              </div>
            ) : preview?.reservation && preview?.policy && preview?.evaluation ? (
              <div style={styles.grid}>
                <div style={styles.leftColumn}>
                  <div style={styles.card}>
                   <div style={styles.sectionEyebrow}>Reservation</div>

<h2 style={styles.cardTitle}>
  {preview.reservation.propertyName || "Your stay"}
</h2>

<div
  style={{
    display: "inline-flex",
    alignItems: "center",
    width: "fit-content",
    marginTop: 10,
    padding: "7px 11px",
    borderRadius: 999,
    border: "1px solid #bfdbfe",
    background: "#eff6ff",
    color: "#1d4ed8",
    fontSize: 14,
    fontWeight: 900,
    letterSpacing: "0.01em",
  }}
>
  {preview.reservation.reservationNumber
    ? `Reservation #${preview.reservation.reservationNumber}`
    : "Reservation reference pending"}
</div>

<div style={styles.infoGrid}>
                      <div style={styles.infoItem}>
  <span>Reservation Number</span>
  <strong>
    {preview.reservation.reservationNumber
      ? `#${preview.reservation.reservationNumber}`
      : "Pending Reference"}
  </strong>
</div>
                     <div style={styles.infoItem}>
                        <span>Guest</span>
                        <strong>{preview.reservation.guestName || "Guest"}</strong>
                      </div>

                      <div style={styles.infoItem}>
                        <span>Status</span>
                        <strong>{preview.reservation.status}</strong>
                      </div>

                      <div style={styles.infoItem}>
                        <span>Check-in</span>
                        <strong>{formatDate(preview.reservation.checkIn)}</strong>
                      </div>

                      <div style={styles.infoItem}>
                        <span>Check-out</span>
                        <strong>{formatDate(preview.reservation.checkOut)}</strong>
                      </div>

                      <div style={styles.infoItem}>
                        <span>Total paid</span>
                        <strong>
                          {formatMoney(preview.reservation.totalAmount, currency)}
                        </strong>
                      </div>

                      <div style={styles.infoItem}>
                        <span>Payment</span>
                        <strong>{preview.reservation.paymentState}</strong>
                      </div>
                    </div>

                    {isCancelled ? (
                      <div style={styles.successBox}>
                        This reservation is already cancelled.
                        {preview.reservation.cancelledAt ? (
                          <>
                            {" "}
                            Cancelled on{" "}
                            {formatDateTime(preview.reservation.cancelledAt)}.
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div style={styles.card}>
                    <div style={styles.sectionEyebrow}>Cancellation policy</div>
                    <h2 style={styles.cardTitle}>{preview.policy.name}</h2>

                    <p style={styles.policySummary}>
                      {preview.policy.guestFacingSummary ||
                        "Cancellation terms apply to this reservation."}
                    </p>

                    <div style={styles.policyMetaGrid}>
                      <div style={styles.policyMetaItem}>
                        <span>Policy type</span>
                        <strong>{preview.policy.type}</strong>
                      </div>

                      <div style={styles.policyMetaItem}>
                        <span>Refund basis</span>
                        <strong>
                          {formatRefundBasis(preview.policy.refundBasis)}
                        </strong>
                      </div>
                    </div>

                    <div style={styles.timeline}>
                      {preview.policy.refundRules.map((rule, index) => (
                        <div
                          key={`${rule.label}-${rule.minHoursBeforeCheckIn}-${index}`}
                          style={styles.timelineItem}
                        >
                          <div style={styles.timelineMarker}>
                            {rule.refundPercent >= 100
                              ? "✓"
                              : rule.refundPercent > 0
                              ? "%"
                              : "×"}
                          </div>

                          <div style={styles.timelineContent}>
                            <div style={styles.timelineTop}>
                              <strong>{rule.label}</strong>
                              <span style={styles.refundBadge}>
                                {rule.refundPercent}%
                              </span>
                            </div>

                            <div style={styles.timelineWindow}>
                              {rule.minHoursBeforeCheckIn > 0
                                ? `${rule.minHoursBeforeCheckIn} hours or more before check-in`
                                : "After the final refund window"}
                            </div>

                            {rule.description ? (
                              <div style={styles.timelineDescription}>
                                {rule.description}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>

                    {preview.policy.nonRefundableScenarios.length > 0 ? (
                      <div style={styles.exceptionsBox}>
                        <div style={styles.exceptionsTitle}>
                          Important non-refundable cases
                        </div>

                        <div style={styles.scenarioGrid}>
                          {preview.policy.nonRefundableScenarios.map((scenario) => (
                            <span key={scenario} style={styles.scenarioPill}>
                              {formatScenario(scenario)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {preview.policy.cancellationTermsAcceptance?.accepted ? (
                      <div style={styles.acceptanceBox}>
                        <strong>Terms accepted at booking</strong>
                        <span>
                          Accepted on{" "}
                          {formatDateTime(
                            preview.policy.cancellationTermsAcceptance.acceptedAt
                          )}
                        </span>
                        {preview.policy.cancellationTermsAcceptance.text ? (
                          <p>
                            {preview.policy.cancellationTermsAcceptance.text}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                <aside style={styles.summaryCard}>
                  <div style={styles.summaryIcon}>↩</div>
                  <div style={styles.sectionEyebrow}>Cancellation result</div>
                  <h2 style={styles.summaryTitle}>{actionCopy.title}</h2>
                  <p style={styles.summaryText}>{actionCopy.text}</p>

                  <div style={styles.refundAmountBox}>
                    <span>{refundAmountLabel}</span>
                    <strong>
                      {formatMoney(displayedRefundAmount, currency)}
                    </strong>
                  </div>

                  <div style={styles.breakdownBox}>
                    <div style={styles.breakdownRow}>
                      <span>Refund percent</span>
                      <strong>{preview.evaluation.refundPercent}%</strong>
                    </div>

                    <div style={styles.breakdownRow}>
                      <span>Refundable base</span>
                      <strong>
                        {formatMoney(
                          preview.evaluation.breakdown?.refundableBase,
                          currency
                        )}
                      </strong>
                    </div>

                    <div style={styles.breakdownRow}>
                      <span>Total paid</span>
                      <strong>
                        {formatMoney(
                          preview.evaluation.breakdown?.totalAmount,
                          currency
                        )}
                      </strong>
                    </div>

                    <div style={styles.breakdownRow}>
                      <span>Nightly subtotal</span>
                      <strong>
                        {formatMoney(
                          preview.evaluation.breakdown?.nightlySubtotal,
                          currency
                        )}
                      </strong>
                    </div>

                    <div style={styles.breakdownRow}>
                      <span>Taxes / non-nightly charges</span>
                      <strong>
                        {formatMoney(
                          (preview.evaluation.breakdown?.taxesTotal ?? 0) +
                            (preview.evaluation.breakdown?.cleaningFee ?? 0) +
                            (preview.evaluation.breakdown?.amenitiesTotal ?? 0),
                          currency
                        )}
                      </strong>
                    </div>
                  </div>

                  {preview.refund ? (
                    <div style={styles.refundProcessedBox}>
                      <strong>
                        {preview.refund.isFullRefund
                          ? "Stripe refund processed"
                          : "Stripe partial refund processed"}
                      </strong>

                      {preview.refund.status ? (
                        <span>Status: {preview.refund.status}</span>
                      ) : null}

                      {preview.refund.refundedAt ? (
                        <span>
                          Submitted on {formatDateTime(preview.refund.refundedAt)}
                        </span>
                      ) : null}

                      {preview.refund.stripeRefundId ? (
                        <span>Refund ID: {preview.refund.stripeRefundId}</span>
                      ) : null}
                    </div>
                  ) : null}

                  {preview.evaluation.matchedRefundRule ? (
                    <div style={styles.matchedRuleBox}>
                      <strong>Matched rule</strong>
                      <span>{preview.evaluation.matchedRefundRule.label}</span>
                      {preview.evaluation.matchedRefundRule.description ? (
                        <p>{preview.evaluation.matchedRefundRule.description}</p>
                      ) : null}
                    </div>
                  ) : null}

                  <div style={styles.refundNotice}>
                    {getRefundExecutionCopy(preview, currency)}
                  </div>

                  {submitMessage ? (
                    <div style={styles.successBox}>{submitMessage}</div>
                  ) : null}

                  {pageError ? (
                    <div style={styles.inlineError}>{pageError}</div>
                  ) : null}

                  {!isCancelled ? (
                    <>
                      <label style={styles.reasonField}>
                        <span>Cancellation reason optional</span>
                        <textarea
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Add a short note for the host..."
                          style={styles.textarea}
                        />
                      </label>

                      <label style={styles.confirmBox}>
                        <input
                          type="checkbox"
                          checked={accepted}
                          onChange={(e) => setAccepted(e.target.checked)}
                          style={styles.checkbox}
                        />

                        <span>{confirmationCopy}</span>
                      </label>

                      <button
                        type="button"
                        disabled={!canSubmit}
                        onClick={handleSubmitCancellation}
                        style={{
                          ...styles.cancelButton,
                          ...(!canSubmit ? styles.cancelButtonDisabled : {}),
                        }}
                      >
                        {submitting
                          ? "Submitting..."
                          : preview.evaluation.requiresHostApproval
                          ? "Request cancellation review"
                          : "Cancel reservation"}
                      </button>
                    </>
                  ) : null}

                  <button
                    type="button"
                    onClick={loadPreview}
                    style={styles.secondaryButtonFull}
                  >
                    Refresh evaluation
                  </button>
                </aside>
              </div>
            ) : (
              <div style={styles.errorCard}>
                <strong>Reservation unavailable</strong>
                <p>Pin&Go could not load this reservation.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer style={styles.footer}>
        <div style={styles.container}>
          © Pin&Go. Reservation management powered by autonomous property
          operations.
        </div>
      </footer>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    color: "#0f172a",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 20,
    background: "rgba(255,255,255,0.94)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid #e2e8f0",
  },
  headerInner: {
    maxWidth: 1180,
    margin: "0 auto",
    padding: "14px 20px",
  },
  brandWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    color: "#0f172a",
    textDecoration: "none",
  },
  logo: {
    width: 48,
    height: 48,
    objectFit: "contain",
    borderRadius: 12,
  },
  brandName: {
    fontSize: 22,
    fontWeight: 950,
    letterSpacing: "-0.03em",
    lineHeight: 1.1,
  },
  slogan: {
    marginTop: 2,
    fontSize: 13,
    color: "#64748b",
    fontWeight: 800,
  },
  main: {
    minHeight: "calc(100vh - 96px)",
  },
  hero: {
    padding: "68px 20px 44px",
    background:
      "radial-gradient(circle at 15% 0%, rgba(37,99,235,0.14), transparent 30%), linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  },
  container: {
    maxWidth: 1180,
    margin: "0 auto",
  },
  badge: {
    display: "inline-flex",
    borderRadius: 999,
    padding: "8px 13px",
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  title: {
    maxWidth: 780,
    margin: "18px 0 0",
    fontSize: "clamp(2.5rem, 5vw, 4.8rem)",
    lineHeight: 1.02,
    fontWeight: 950,
    letterSpacing: "-0.055em",
  },
  subtitle: {
    maxWidth: 760,
    margin: "18px 0 0",
    color: "#475569",
    fontSize: 18,
    lineHeight: 1.7,
    fontWeight: 650,
  },
  contentSection: {
    padding: "34px 20px 76px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.25fr) minmax(340px, 0.75fr)",
    gap: 24,
    alignItems: "start",
  },
  leftColumn: {
    display: "grid",
    gap: 22,
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 28,
    padding: 28,
    boxShadow: "0 18px 50px rgba(15, 23, 42, 0.08)",
  },
  summaryCard: {
    position: "sticky",
    top: 92,
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 28,
    padding: 28,
    boxShadow: "0 24px 70px rgba(15, 23, 42, 0.14)",
  },
  sectionEyebrow: {
    fontSize: 12,
    fontWeight: 950,
    color: "#2563eb",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 10,
  },
  cardTitle: {
    margin: 0,
    fontSize: 28,
    fontWeight: 950,
    letterSpacing: "-0.04em",
  },
  loadingTitle: {
    fontSize: 22,
    fontWeight: 950,
    letterSpacing: "-0.03em",
  },
  mutedText: {
    margin: "10px 0 0",
    color: "#64748b",
    lineHeight: 1.6,
  },
  infoGrid: {
    marginTop: 22,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 12,
  },
  infoItem: {
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: "14px 15px",
    background: "#f8fafc",
    display: "grid",
    gap: 5,
  },
  policyMetaGrid: {
    marginTop: 18,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 12,
  },
  policyMetaItem: {
    border: "1px solid #dbeafe",
    borderRadius: 18,
    padding: "14px 15px",
    background: "#eff6ff",
    display: "grid",
    gap: 5,
  },
  policySummary: {
    margin: "14px 0 0",
    color: "#475569",
    lineHeight: 1.7,
    fontSize: 15,
    fontWeight: 700,
  },
  timeline: {
    marginTop: 22,
    display: "grid",
    gap: 13,
  },
  timelineItem: {
    display: "grid",
    gridTemplateColumns: "38px 1fr",
    gap: 12,
    alignItems: "start",
  },
  timelineMarker: {
    width: 34,
    height: 34,
    borderRadius: 14,
    display: "grid",
    placeItems: "center",
    background: "#dcfce7",
    border: "1px solid #bbf7d0",
    color: "#15803d",
    fontSize: 15,
    fontWeight: 950,
  },
  timelineContent: {
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    background: "#ffffff",
    padding: "13px 14px",
    display: "grid",
    gap: 5,
  },
  timelineTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  refundBadge: {
    borderRadius: 999,
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#15803d",
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 950,
  },
  timelineWindow: {
    color: "#334155",
    fontSize: 13,
    fontWeight: 850,
  },
  timelineDescription: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 1.45,
    fontWeight: 700,
  },
  exceptionsBox: {
    marginTop: 22,
    borderTop: "1px solid #e2e8f0",
    paddingTop: 18,
    display: "grid",
    gap: 12,
  },
  exceptionsTitle: {
    color: "#0f172a",
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  scenarioGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  scenarioPill: {
    borderRadius: 999,
    padding: "7px 10px",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    color: "#334155",
    fontSize: 12,
    fontWeight: 850,
  },
  acceptanceBox: {
    marginTop: 18,
    border: "1px solid #dbeafe",
    background: "#eff6ff",
    borderRadius: 18,
    padding: 15,
    display: "grid",
    gap: 6,
    color: "#1e3a8a",
    fontSize: 13,
    lineHeight: 1.55,
    fontWeight: 700,
  },
  summaryIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    display: "grid",
    placeItems: "center",
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1d4ed8",
    fontSize: 24,
    fontWeight: 950,
    marginBottom: 16,
  },
  summaryTitle: {
    margin: 0,
    fontSize: 30,
    fontWeight: 950,
    letterSpacing: "-0.04em",
  },
  summaryText: {
    margin: "12px 0 0",
    color: "#475569",
    lineHeight: 1.65,
    fontSize: 14,
    fontWeight: 700,
  },
  refundAmountBox: {
    marginTop: 20,
    borderRadius: 22,
    padding: 20,
    background:
      "linear-gradient(135deg, #020617 0%, #0f172a 52%, #1d4ed8 100%)",
    color: "#ffffff",
    display: "grid",
    gap: 6,
    boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
  },
  breakdownBox: {
    marginTop: 18,
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 15,
    display: "grid",
    gap: 10,
    background: "#f8fafc",
  },
  breakdownRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    color: "#475569",
    fontSize: 13,
  },
  matchedRuleBox: {
    marginTop: 16,
    border: "1px solid #bbf7d0",
    background: "#f0fdf4",
    color: "#14532d",
    borderRadius: 18,
    padding: 15,
    display: "grid",
    gap: 5,
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 750,
  },
  refundProcessedBox: {
    marginTop: 16,
    border: "1px solid #bbf7d0",
    background: "#f0fdf4",
    color: "#14532d",
    borderRadius: 18,
    padding: 15,
    display: "grid",
    gap: 5,
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 800,
    wordBreak: "break-word",
  },
  refundNotice: {
    marginTop: 16,
    border: "1px solid #fde68a",
    background: "#fffbeb",
    color: "#92400e",
    borderRadius: 18,
    padding: 14,
    fontSize: 13,
    lineHeight: 1.55,
    fontWeight: 800,
  },
  reasonField: {
    marginTop: 18,
    display: "grid",
    gap: 8,
    color: "#334155",
    fontSize: 13,
    fontWeight: 900,
  },
  textarea: {
    width: "100%",
    minHeight: 92,
    boxSizing: "border-box",
    border: "1px solid #cbd5e1",
    borderRadius: 16,
    padding: "12px 13px",
    fontSize: 14,
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
  },
  confirmBox: {
    marginTop: 14,
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 14,
    background: "#f8fafc",
    color: "#334155",
    fontSize: 12,
    lineHeight: 1.55,
    fontWeight: 750,
    cursor: "pointer",
  },
  checkbox: {
    width: 18,
    height: 18,
    marginTop: 2,
    cursor: "pointer",
    flexShrink: 0,
  },
  cancelButton: {
    marginTop: 14,
    width: "100%",
    border: "none",
    borderRadius: 18,
    background: "#dc2626",
    color: "#ffffff",
    padding: "15px 18px",
    fontSize: 15,
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 14px 32px rgba(220,38,38,0.24)",
  },
  cancelButtonDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
    boxShadow: "none",
  },
  secondaryButton: {
    border: "1px solid #cbd5e1",
    borderRadius: 14,
    background: "#ffffff",
    color: "#0f172a",
    padding: "11px 14px",
    fontWeight: 900,
    cursor: "pointer",
  },
  secondaryButtonFull: {
    marginTop: 12,
    width: "100%",
    border: "1px solid #cbd5e1",
    borderRadius: 18,
    background: "#ffffff",
    color: "#0f172a",
    padding: "13px 15px",
    fontWeight: 900,
    cursor: "pointer",
  },
  successBox: {
    marginTop: 14,
    border: "1px solid #bbf7d0",
    background: "#f0fdf4",
    color: "#166534",
    borderRadius: 16,
    padding: 13,
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 850,
  },
  inlineError: {
    marginTop: 14,
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#991b1b",
    borderRadius: 16,
    padding: 13,
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 850,
  },
  errorCard: {
    background: "#fff1f2",
    border: "1px solid #fecdd3",
    color: "#9f1239",
    borderRadius: 24,
    padding: 26,
    display: "grid",
    gap: 10,
    fontWeight: 800,
  },
  footer: {
    borderTop: "1px solid #e2e8f0",
    padding: "24px 20px",
    color: "#64748b",
    fontSize: 14,
    background: "#ffffff",
    textAlign: "center",
  },
};