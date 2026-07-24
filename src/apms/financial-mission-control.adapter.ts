import type {
  MissionControlOperationalProjection,
} from "./mission-control-read-model";

export interface FinancialMissionControlInput {
  publicBookingEnabled: boolean;
  activeDirectBookingCount: number;
  stripeConnectAccountId?: string | null;
  stripeConnectStatus: string;
  stripeConnectChargesEnabled: boolean;
  stripeConnectPayoutsEnabled: boolean;
  stripeConnectDisabledReason?: string | null;
  stripeConnectLastSyncedAt?: Date | null;
  signalAt: Date;
}

function cleanText(
  value: unknown,
  maxLength = 500
) {
  const text = String(value ?? "").trim();

  if (!text) {
    return null;
  }

  return text.slice(0, maxLength);
}

function normalizeStatus(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isFinancialApplicable(
  input: FinancialMissionControlInput
) {
  return (
    input.publicBookingEnabled ||
    input.activeDirectBookingCount > 0 ||
    Boolean(
      cleanText(
        input.stripeConnectAccountId
      )
    )
  );
}

function getSignalAt(
  input: FinancialMissionControlInput
) {
  return (
    input.stripeConnectLastSyncedAt ??
    input.signalAt
  );
}

function buildWaitingItem(input: {
  issueCode: string;
  title: string;
  issue: string;
  nextAutomaticStep: string;
  lastSignalAt: Date;
}): MissionControlOperationalProjection {
  return {
    issueCode: input.issueCode,
    title: input.title,
    issue: input.issue,
    engine: "FINANCIAL",
    workflowState: "WAITING",
    actionRequired: false,
    responsibleActor: "SYSTEM",
    recommendedAction: null,
    nextAutomaticStep:
      input.nextAutomaticStep,
    actionTarget: "PAYMENT",
    lastSignalAt: input.lastSignalAt,
    exhausted: false,
  };
}

function buildHostActionItem(input: {
  issueCode: string;
  title: string;
  issue: string;
  recommendedAction: string;
  lastSignalAt: Date;
}): MissionControlOperationalProjection {
  return {
    issueCode: input.issueCode,
    title: input.title,
    issue: input.issue,
    engine: "FINANCIAL",
    workflowState: "ACTION_REQUIRED",
    actionRequired: true,
    responsibleActor: "HOST",
    recommendedAction:
      input.recommendedAction,
    nextAutomaticStep: null,
    actionTarget: "PAYMENT",
    lastSignalAt: input.lastSignalAt,
    exhausted: false,
  };
}

export function mapFinancialMissionControlOperationalItems(
  input: FinancialMissionControlInput
): MissionControlOperationalProjection[] {
  if (!isFinancialApplicable(input)) {
    return [];
  }

  const status = normalizeStatus(
    input.stripeConnectStatus
  );
  const accountId = cleanText(
    input.stripeConnectAccountId
  );
  const signalAt = getSignalAt(input);
  const payoutReady = Boolean(
    accountId &&
    status === "READY" &&
    input.stripeConnectChargesEnabled &&
    input.stripeConnectPayoutsEnabled
  );

  if (payoutReady) {
    return [];
  }

  if (status === "PENDING_VERIFICATION") {
    return [
      buildWaitingItem({
        issueCode:
          "FINANCIAL_PAYOUT_VERIFICATION_PENDING",
        title:
          "Stripe payout verification is pending",
        issue:
          "Stripe is reviewing the host payout account. No host action is required while verification remains pending.",
        nextAutomaticStep:
          "Pin&Go will reflect the next synchronized Stripe verification status automatically.",
        lastSignalAt: signalAt,
      }),
    ];
  }

  if (
    status === "NOT_CONNECTED" ||
    !accountId
  ) {
    return [
      buildHostActionItem({
        issueCode:
          "FINANCIAL_PAYOUT_ACCOUNT_NOT_CONNECTED",
        title:
          "Host payout account is not connected",
        issue:
          "Direct Booking financial workflows require a connected Stripe payout account.",
        recommendedAction:
          "Open Host Payouts and connect the Stripe payout account.",
        lastSignalAt: signalAt,
      }),
    ];
  }

  if (status === "ONBOARDING_REQUIRED") {
    return [
      buildHostActionItem({
        issueCode:
          "FINANCIAL_PAYOUT_ONBOARDING_REQUIRED",
        title:
          "Stripe payout onboarding must be completed",
        issue:
          "The Stripe payout account exists, but onboarding is incomplete and Direct Booking payouts are blocked.",
        recommendedAction:
          "Open Host Payouts and complete the outstanding Stripe onboarding steps.",
        lastSignalAt: signalAt,
      }),
    ];
  }

  if (status === "RESTRICTED") {
    const disabledReason = cleanText(
      input.stripeConnectDisabledReason
    );

    return [
      buildHostActionItem({
        issueCode:
          "FINANCIAL_PAYOUT_ACCOUNT_RESTRICTED",
        title:
          "Stripe payout account is restricted",
        issue: disabledReason
          ? `Stripe restricted the host payout account: ${disabledReason}.`
          : "Stripe restricted the host payout account and Direct Booking payouts cannot proceed.",
        recommendedAction:
          "Open Host Payouts and complete Stripe's outstanding account requirements.",
        lastSignalAt: signalAt,
      }),
    ];
  }

  if (status === "READY") {
    return [
      buildHostActionItem({
        issueCode:
          "FINANCIAL_PAYOUT_ACCOUNT_NOT_READY",
        title:
          "Stripe payout capabilities are not ready",
        issue:
          "Stripe reports the payout account as ready, but charges or payouts are still disabled.",
        recommendedAction:
          "Open Host Payouts, review the Stripe account requirements and refresh the payout status.",
        lastSignalAt: signalAt,
      }),
    ];
  }

  return [
    buildWaitingItem({
      issueCode:
        "FINANCIAL_PAYOUT_STATUS_SYNC_PENDING",
      title:
        "Financial payout status is being reconciled",
      issue:
        "Pin&Go does not yet have a conclusive Stripe payout status for this organization.",
      nextAutomaticStep:
        "Pin&Go will reflect the next synchronized Stripe payout status automatically.",
      lastSignalAt: signalAt,
    }),
  ];
}
