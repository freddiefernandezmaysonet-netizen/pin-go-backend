import { fromZonedTime } from "date-fns-tz";

import {
  getPropertyKnowledgeSnapshot,
  type PropertyKnowledgeLanguage,
} from "../property-knowledge.service.js";
import type {
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";
import type {
  PinAIConversationMemory,
} from "./conversation-memory.js";
import type {
  PinAIRuntimeToolExecutor,
} from "./tool-executor.js";
import { PinGoRuntimeEligibilityChecks } from "./pin-go-eligibility-checks.js";
import {
  searchGooglePlaces,
  type GooglePlacesSearchInput,
  type GooglePlacesSearchResult,
} from "./google-places-read-client.js";

type RuntimeReadPrisma = Readonly<{
  property: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  reservation: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  guestJourney: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  accessGrant: Readonly<{
    findMany(args: unknown): Promise<any[]>;
  }>;
  cleaningConfirmation: Readonly<{
    findFirst(args: unknown): Promise<any>;
    findMany(args: unknown): Promise<any[]>;
  }>;
  propertyBlockedDate: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  reservationModification: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
}>;

type RuntimePricingCalculator = (input: Readonly<{
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  selectedAmenityIds?: string[];
  excludeReservationId?: string;
}>) => Promise<Readonly<{
  currency?: unknown;
  totalAmount: unknown;
  totalAmountCents: unknown;
  nightlyRates?: readonly Readonly<{
    date?: unknown;
    rate?: unknown;
  }>[];
}>>;

type RuntimeCancellationPolicyEvaluator = (input: Readonly<{
  snapshot: Readonly<Record<string, unknown>>;
  checkIn: Date;
  totalAmount: unknown;
  pricingBreakdown?: unknown;
  requestedAt: Date;
  actor: "GUEST";
}>) => Promise<Readonly<{
  requestedAt: unknown;
  checkIn: unknown;
  freeCancellationDeadline: unknown;
  hoursBeforeCheckIn: unknown;
  beforeDeadline: unknown;
  refundPercent: unknown;
  refundAmount: unknown;
  refundAmountCents: unknown;
  usesTieredRules: unknown;
  matchedRefundRule: unknown;
  eligibleForGuestSelfCancellation: unknown;
  eligibleForAutoRefund: unknown;
  requiresHostApproval: unknown;
  reason: unknown;
  breakdown: Readonly<Record<string, unknown>>;
}>>;

type RuntimeLocalPlacesSearch = (
  input: GooglePlacesSearchInput,
) => Promise<GooglePlacesSearchResult>;

type GuestJourneyCoordinationView = Readonly<{
  intentType: string;
  targetEngine: string;
  status: string;
  lastAttemptAt: Date | null;
  nextActionAt: Date | null;
  exhaustedAt: Date | null;
}>;

export class PinGoRuntimeReadToolExecutor implements PinAIRuntimeToolExecutor {
  private readonly eligibility: PinGoRuntimeEligibilityChecks;

  constructor(
    private readonly prisma: RuntimeReadPrisma,
    private readonly calculatePricing: RuntimePricingCalculator =
      calculateRuntimeExtensionPricing,
    private readonly evaluateCancellationPolicy: RuntimeCancellationPolicyEvaluator =
      evaluateRuntimeCancellationPolicy,
    private readonly searchLocalPlaces: RuntimeLocalPlacesSearch =
      searchGooglePlaces,
  ) {
    this.eligibility = new PinGoRuntimeEligibilityChecks(prisma);
  }

  async execute(
    tool: PinAIRuntimeToolName,
    args: Readonly<Record<string, unknown>>,
    request: PinAIRuntimeRequest,
    _memory: PinAIConversationMemory,
  ): Promise<Readonly<Record<string, unknown>>> {
    switch (tool) {
      case "get_property_knowledge":
        return this.getPropertyKnowledge(request);
      case "get_reservation_context":
        return this.getReservationContext(request);
      case "get_guest_journey_status":
        return this.getGuestJourneyStatus(request);
      case "get_access_status":
        return this.getAccessStatus(request);
      case "get_cleaning_status":
        return this.getCleaningStatus(request);
      case "check_early_checkin":
        return this.eligibility.checkEarlyCheckin(request, args);
      case "check_late_checkout":
        return this.eligibility.checkLateCheckout(request, args);
      case "check_extension_availability":
        return this.eligibility.checkExtensionAvailability(request, args);
      case "calculate_extension_price":
        return this.calculateExtensionPrice(request, args);
      case "check_date_change":
        return this.checkDateChange(request, args);
      case "get_cancellation_policy":
        return this.getCancellationPolicy(request);
      case "get_payment_context":
        return this.getPaymentContext(request);
      case "search_local_places":
        return this.searchNearbyPlaces(request, args);
      default:
        throw new Error(`PIN_AI_RUNTIME_READ_TOOL_NOT_IMPLEMENTED:${tool}`);
    }
  }

  private async searchNearbyPlaces(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length < 2 || query.length > 120 || /[\u0000-\u001f]/.test(query)) {
      return localPlacesUnavailable("INVALID_LOCAL_PLACES_QUERY");
    }

    const radiusMeters = integerInRange(args.radiusMeters, 500, 50_000) ?? 15_000;
    const maxResults = integerInRange(args.maxResults, 1, 5) ?? 5;
    if (
      (args.radiusMeters !== undefined &&
        integerInRange(args.radiusMeters, 500, 50_000) === null) ||
      (args.maxResults !== undefined &&
        integerInRange(args.maxResults, 1, 5) === null)
    ) {
      return localPlacesUnavailable("INVALID_LOCAL_PLACES_BOUNDS");
    }
    const property = await this.prisma.property.findFirst({
      where: {
        id: request.context.propertyId,
        organizationId: request.context.organizationId,
        status: "ACTIVE",
      },
      select: {
        id: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!property) {
      throw new Error("PIN_AI_RUNTIME_PROPERTY_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    const latitude = finiteCoordinate(property.latitude, -90, 90);
    const longitude = finiteCoordinate(property.longitude, -180, 180);
    if (latitude === null || longitude === null) {
      return localPlacesUnavailable("PROPERTY_COORDINATES_UNAVAILABLE");
    }

    try {
      const result = await this.searchLocalPlaces({
        query,
        latitude,
        longitude,
        radiusMeters,
        maxResults,
        languageCode: request.context.preferredLanguage === "es" ? "es" : "en",
      });

      return {
        decision: "LOCAL_PLACES_SEARCH_COMPLETED",
        authorizationGranted: false,
        requiresHumanReview: false,
        query,
        searchRadiusMeters: radiusMeters,
        currentAsOf: request.context.currentLocalDateTime,
        provider: result.provider,
        attribution: "Google Maps",
        places: result.places,
        externalReadPerformed: true,
        currentOpeningHoursVerified: false,
        currentPricesVerified: false,
        bookingExecuted: false,
        actionsExecuted: false,
        note:
          "Read-only local search. Distances are straight-line estimates. Current hours, prices, availability, and booking status were not requested or verified.",
      };
    } catch {
      return localPlacesUnavailable("LOCAL_PLACES_PROVIDER_UNAVAILABLE");
    }
  }

  private async getPaymentContext(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        reservationNumber: true,
        status: true,
        source: true,
        paymentState: true,
        totalAmount: true,
        amountCollected: true,
        amountRefunded: true,
        currency: true,
        stripeCheckoutSessionId: true,
        stripePaymentIntentId: true,
        stripeChargeId: true,
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    const totalAmount =
      reservation.totalAmount == null
        ? null
        : toPersistedMoney(reservation.totalAmount);
    const amountCollected = toPersistedMoney(reservation.amountCollected);
    const amountRefunded = toPersistedMoney(reservation.amountRefunded);
    if (
      amountCollected === null ||
      amountCollected < 0 ||
      amountRefunded === null ||
      amountRefunded < 0 ||
      (totalAmount !== null && totalAmount < 0)
    ) {
      return {
        decision: "PAYMENT_CONTEXT_INVALID",
        authorizationGranted: false,
        requiresHumanReview: true,
        paymentAuthorized: false,
        chargeExecuted: false,
        refundExecuted: false,
        transferExecuted: false,
        note:
          "Persisted payment amounts are incomplete or invalid. Runtime V1 will not infer or execute a financial action.",
      };
    }

    const amountRetained = Math.max(
      0,
      Math.round((amountCollected - amountRefunded) * 100) / 100,
    );

    return {
      decision: "PAYMENT_CONTEXT_READ",
      authorizationGranted: false,
      requiresHumanReview: false,
      reservation: {
        reservationNumber: reservation.reservationNumber,
        status: reservation.status,
        source: reservation.source,
      },
      payment: {
        state: reservation.paymentState,
        currency: String(reservation.currency ?? "usd").toLowerCase(),
        totalAmount,
        amountCollected,
        amountRefunded,
        amountRetained,
        paymentRecorded:
          reservation.paymentState !== "NONE" || amountCollected > 0,
        refundRecorded:
          reservation.paymentState === "PARTIALLY_REFUNDED" ||
          reservation.paymentState === "REFUNDED" ||
          amountRefunded > 0,
      },
      providerEvidence: {
        checkoutSessionRecorded: Boolean(reservation.stripeCheckoutSessionId),
        paymentIntentRecorded: Boolean(reservation.stripePaymentIntentId),
        chargeRecorded: Boolean(reservation.stripeChargeId),
      },
      financialAuthority: {
        canCharge: false,
        canRefund: false,
        canTransfer: false,
        deterministicAuthorizationRequired: true,
      },
      paymentAuthorized: false,
      chargeExecuted: false,
      refundExecuted: false,
      transferExecuted: false,
      note:
        "Read-only persisted payment context only. No charge, refund, transfer, approval, or reservation change was executed.",
    };
  }

  private async getCancellationPolicy(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        status: true,
        checkIn: true,
        totalAmount: true,
        currency: true,
        pricingBreakdown: true,
        cancellationPolicySnapshot: true,
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    const snapshot = parseCancellationPolicySnapshot(
      reservation.cancellationPolicySnapshot,
    );
    if (!snapshot) {
      return {
        decision: "CANCELLATION_POLICY_SNAPSHOT_UNAVAILABLE",
        authorizationGranted: false,
        requiresHumanReview: true,
        cancellationExecuted: false,
        refundExecuted: false,
        chargeExecuted: false,
        note:
          "The reservation-specific cancellation policy snapshot is missing or invalid. Runtime V1 will not substitute the property's current policy.",
      };
    }

    const requestedAt = new Date(request.context.currentLocalDateTime);
    if (Number.isNaN(requestedAt.getTime())) {
      return {
        decision: "CANCELLATION_POLICY_EVALUATION_TIME_INVALID",
        authorizationGranted: false,
        requiresHumanReview: true,
        cancellationExecuted: false,
        refundExecuted: false,
        chargeExecuted: false,
      };
    }

    const evaluation = await this.evaluateCancellationPolicy({
      snapshot,
      checkIn: reservation.checkIn,
      totalAmount: reservation.totalAmount,
      pricingBreakdown: reservation.pricingBreakdown,
      requestedAt,
      actor: "GUEST",
    });
    const refundAmount = toMoney(evaluation.refundAmount);
    const refundAmountCents = Number(evaluation.refundAmountCents);
    const refundPercent = Number(evaluation.refundPercent);
    if (
      refundAmount === null ||
      !Number.isInteger(refundAmountCents) ||
      refundAmountCents < 0 ||
      !Number.isFinite(refundPercent) ||
      refundPercent < 0 ||
      refundPercent > 100
    ) {
      throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_EVALUATION_INVALID");
    }

    return {
      decision: "CANCELLATION_POLICY_EVALUATED",
      authorizationGranted: false,
      requiresHumanReview: evaluation.requiresHostApproval === true,
      reservationStatus: reservation.status,
      currency: String(reservation.currency ?? "usd").toLowerCase(),
      policy: serializeCancellationPolicySnapshot(snapshot),
      evaluation: {
        requestedAt: evaluation.requestedAt,
        checkIn: evaluation.checkIn,
        freeCancellationDeadline: evaluation.freeCancellationDeadline,
        hoursBeforeCheckIn: evaluation.hoursBeforeCheckIn,
        beforeDeadline: evaluation.beforeDeadline,
        refundPercent,
        estimatedRefundAmount: refundAmount,
        estimatedRefundAmountCents: refundAmountCents,
        estimateOnly: true,
        usesTieredRules: evaluation.usesTieredRules,
        matchedRefundRule: evaluation.matchedRefundRule,
        eligibleForGuestSelfCancellation:
          evaluation.eligibleForGuestSelfCancellation,
        eligibleForAutoRefund: evaluation.eligibleForAutoRefund,
        requiresHostApproval: evaluation.requiresHostApproval,
        reason: evaluation.reason,
        refundableBase: toMoney(evaluation.breakdown.refundableBase),
        refundableBaseCents: evaluation.breakdown.refundableBaseCents,
      },
      cancellationExecuted: false,
      refundExecuted: false,
      chargeExecuted: false,
      note:
        "Read-only reservation policy evaluation only. No cancellation, refund, charge, approval, or reservation change was executed.",
    };
  }

  private async checkDateChange(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const proposedCheckInDate = parseDateOnly(args.proposedCheckInDate);
    const proposedCheckOutDate = parseDateOnly(args.proposedCheckOutDate);

    if (!proposedCheckInDate || !proposedCheckOutDate) {
      return dateChangeDenied(
        args.proposedCheckInDate == null || args.proposedCheckOutDate == null
          ? "PROPOSED_DATES_REQUIRED"
          : "INVALID_PROPOSED_DATES",
      );
    }

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        status: "ACTIVE",
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        propertyId: true,
        checkIn: true,
        checkOut: true,
        totalAmount: true,
        currency: true,
        selectedAmenityIds: true,
        property: {
          select: {
            timezone: true,
            checkInTime: true,
            checkOutTime: true,
            minimumNights: true,
            maximumNights: true,
          },
        },
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    const timezone = String(reservation.property.timezone ?? "").trim();
    if (!timezone) {
      throw new Error("PIN_AI_RUNTIME_PROPERTY_TIMEZONE_REQUIRED");
    }

    const proposedCheckIn = buildPropertyDate(
      proposedCheckInDate,
      reservation.property.checkInTime ?? "16:00",
      timezone,
    );
    const proposedCheckOut = buildPropertyDate(
      proposedCheckOutDate,
      reservation.property.checkOutTime ?? "11:00",
      timezone,
    );

    if (
      Number.isNaN(proposedCheckIn.getTime()) ||
      Number.isNaN(proposedCheckOut.getTime()) ||
      proposedCheckOut <= proposedCheckIn
    ) {
      return dateChangeDenied("INVALID_PROPOSED_DATES");
    }

    const currentDateTime = new Date(request.context.currentLocalDateTime);
    if (
      Number.isNaN(currentDateTime.getTime()) ||
      proposedCheckIn <= currentDateTime
    ) {
      return dateChangeDenied("PROPOSED_CHECK_IN_MUST_BE_IN_FUTURE");
    }

    if (
      proposedCheckIn.getTime() === reservation.checkIn.getTime() &&
      proposedCheckOut.getTime() === reservation.checkOut.getTime()
    ) {
      return {
        ...dateChangeDenied("NO_DATE_CHANGE"),
        currentCheckIn: reservation.checkIn,
        currentCheckOut: reservation.checkOut,
      };
    }

    const nights = dateOnlyNightCount(
      proposedCheckInDate,
      proposedCheckOutDate,
    );
    const minimumNights = Math.max(
      1,
      Number(reservation.property.minimumNights ?? 1),
    );
    if (nights < minimumNights) {
      return {
        ...dateChangeDenied("MINIMUM_STAY_NOT_MET"),
        nights,
        minimumNights,
      };
    }
    if (
      reservation.property.maximumNights &&
      nights > reservation.property.maximumNights
    ) {
      return {
        ...dateChangeDenied("MAXIMUM_STAY_EXCEEDED"),
        nights,
        maximumNights: reservation.property.maximumNights,
      };
    }

    const reservationConflict = await this.prisma.reservation.findFirst({
      where: {
        id: { not: reservation.id },
        propertyId: reservation.propertyId,
        status: "ACTIVE",
        checkIn: { lt: proposedCheckOut },
        checkOut: { gt: proposedCheckIn },
      },
      select: { id: true },
    });
    if (reservationConflict) {
      return {
        ...dateChangeDenied("NOT_AVAILABLE"),
        reason: "ACTIVE_RESERVATION_CONFLICT",
        proposedCheckIn,
        proposedCheckOut,
      };
    }

    const modificationHold = await this.prisma.reservationModification.findFirst({
      where: {
        reservation: { propertyId: reservation.propertyId },
        proposedCheckIn: { lt: proposedCheckOut },
        proposedCheckOut: { gt: proposedCheckIn },
        OR: [
          { status: "PAYMENT_PROCESSING" },
          {
            status: "AWAITING_PAYMENT",
            checkoutExpiresAt: { gt: currentDateTime },
          },
        ],
      },
      select: { id: true },
    });
    if (modificationHold) {
      return {
        ...dateChangeDenied("NOT_AVAILABLE"),
        reason: "ACTIVE_RESERVATION_MODIFICATION_HOLD",
        proposedCheckIn,
        proposedCheckOut,
      };
    }

    const blockedDate = await this.prisma.propertyBlockedDate.findFirst({
      where: {
        propertyId: reservation.propertyId,
        startDate: { lt: proposedCheckOut },
        endDate: { gt: proposedCheckIn },
      },
      select: { id: true },
    });
    if (blockedDate) {
      return {
        ...dateChangeDenied("NOT_AVAILABLE"),
        reason: "PROPERTY_BLOCKED_DATE",
        proposedCheckIn,
        proposedCheckOut,
      };
    }

    const currentTotalAmount = toMoney(reservation.totalAmount);
    if (currentTotalAmount === null || currentTotalAmount <= 0) {
      return dateChangeDenied("CURRENT_RESERVATION_TOTAL_UNAVAILABLE");
    }

    const pricing = await this.calculatePricing({
      propertyId: reservation.propertyId,
      checkIn: proposedCheckIn,
      checkOut: proposedCheckOut,
      selectedAmenityIds: Array.isArray(reservation.selectedAmenityIds)
        ? reservation.selectedAmenityIds
        : [],
      excludeReservationId: reservation.id,
    });
    const proposedTotalAmount = toMoney(pricing.totalAmount);
    const proposedTotalAmountCents = Number(pricing.totalAmountCents);
    if (
      proposedTotalAmount === null ||
      !Number.isInteger(proposedTotalAmountCents) ||
      proposedTotalAmountCents < 0
    ) {
      throw new Error("PIN_AI_RUNTIME_DATE_CHANGE_PRICE_INVALID");
    }

    const currentTotalAmountCents = Math.round(currentTotalAmount * 100);
    const amountDifferenceCents =
      proposedTotalAmountCents - currentTotalAmountCents;
    const amountDifference = amountDifferenceCents / 100;

    return {
      decision: "DATE_CHANGE_AVAILABLE_FOR_REVIEW",
      authorizationGranted: false,
      priceCalculated: true,
      priceIsEstimate: true,
      currentCheckIn: reservation.checkIn,
      currentCheckOut: reservation.checkOut,
      proposedCheckIn,
      proposedCheckOut,
      nights,
      currency: String(
        pricing.currency ?? reservation.currency ?? "usd",
      ).toLowerCase(),
      currentReservationTotal: currentTotalAmount,
      proposedReservationTotal: proposedTotalAmount,
      amountDifference,
      amountDifferenceCents,
      financialReview:
        amountDifferenceCents > 0
          ? "ADDITIONAL_PAYMENT_REVIEW_REQUIRED"
          : amountDifferenceCents < 0
            ? "POTENTIAL_REDUCTION_REVIEW_REQUIRED"
            : "NO_PRICE_DIFFERENCE",
      additionalAmount: amountDifferenceCents > 0 ? amountDifference : null,
      additionalAmountCents:
        amountDifferenceCents > 0 ? amountDifferenceCents : null,
      potentialReductionAmount:
        amountDifferenceCents < 0 ? Math.abs(amountDifference) : null,
      potentialReductionAmountCents:
        amountDifferenceCents < 0 ? Math.abs(amountDifferenceCents) : null,
      requiresHumanReview: true,
      chargeExecuted: false,
      refundExecuted: false,
      reservationChanged: false,
      note:
        "Read-only estimate only. No reservation change, approval, refund, payment, or charge was executed.",
    };
  }

  private async calculateExtensionPrice(
    request: PinAIRuntimeRequest,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const availability = await this.eligibility.checkExtensionAvailability(
      request,
      args,
    );

    if (availability.decision !== "CALENDAR_AVAILABLE_FOR_PRICING") {
      return {
        ...availability,
        priceCalculated: false,
        chargeExecuted: false,
        reservationChanged: false,
      };
    }

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        status: "ACTIVE",
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        propertyId: true,
        checkIn: true,
        checkOut: true,
        totalAmount: true,
        currency: true,
        selectedAmenityIds: true,
        property: {
          select: {
            maximumNights: true,
          },
        },
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    const proposedCheckOut = availability.proposedCheckOut;
    const additionalNights = availability.additionalNights;
    if (
      !(proposedCheckOut instanceof Date) ||
      !Number.isInteger(additionalNights) ||
      Number(additionalNights) <= 0
    ) {
      throw new Error("PIN_AI_RUNTIME_EXTENSION_AVAILABILITY_CONTRACT_INVALID");
    }

    const proposedNights = Math.ceil(
      (proposedCheckOut.getTime() - reservation.checkIn.getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (
      reservation.property.maximumNights &&
      proposedNights > reservation.property.maximumNights
    ) {
      return {
        decision: "MAXIMUM_STAY_EXCEEDED",
        authorizationGranted: false,
        priceCalculated: false,
        additionalNights,
        maximumNights: reservation.property.maximumNights,
        proposedNights,
        chargeExecuted: false,
        reservationChanged: false,
      };
    }

    const selectedAmenityIds = Array.isArray(reservation.selectedAmenityIds)
      ? reservation.selectedAmenityIds
      : [];
    const pricingBaseInput = {
      propertyId: reservation.propertyId,
      checkIn: reservation.checkIn,
      selectedAmenityIds,
      excludeReservationId: reservation.id,
    };

    const [currentCanonicalPricing, proposedCanonicalPricing] =
      await Promise.all([
        this.calculatePricing({
          ...pricingBaseInput,
          checkOut: reservation.checkOut,
        }),
        this.calculatePricing({
          ...pricingBaseInput,
          checkOut: proposedCheckOut,
        }),
      ]);

    const currentCanonicalTotal = toMoney(currentCanonicalPricing.totalAmount);
    const currentCanonicalTotalCents = Number(
      currentCanonicalPricing.totalAmountCents,
    );
    const proposedCanonicalTotal = toMoney(proposedCanonicalPricing.totalAmount);
    const proposedCanonicalTotalCents = Number(
      proposedCanonicalPricing.totalAmountCents,
    );
    if (
      currentCanonicalTotal === null ||
      !Number.isInteger(currentCanonicalTotalCents) ||
      currentCanonicalTotalCents < 0 ||
      proposedCanonicalTotal === null ||
      !Number.isInteger(proposedCanonicalTotalCents) ||
      proposedCanonicalTotalCents < 0
    ) {
      throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_INVALID");
    }

    const amountDifferenceCents =
      proposedCanonicalTotalCents - currentCanonicalTotalCents;
    const amountDifference = amountDifferenceCents / 100;
    const extensionStartDateKey = reservation.checkOut
      .toISOString()
      .slice(0, 10);
    const extensionNightlyRates = Array.isArray(
      proposedCanonicalPricing.nightlyRates,
    )
      ? proposedCanonicalPricing.nightlyRates
          .filter(
            (item) =>
              typeof item?.date === "string" &&
              item.date >= extensionStartDateKey,
          )
          .map((item) => ({
            date: item.date,
            rate: toMoney(item.rate),
          }))
      : [];
    const historicalReservationTotal = toMoney(reservation.totalAmount);

    return {
      decision:
        amountDifferenceCents > 0
          ? "PRICE_CALCULATED_FOR_REVIEW"
          : "PRICE_REQUIRES_HUMAN_REVIEW",
      authorizationGranted: false,
      priceCalculated: true,
      priceIsEstimate: true,
      pricingBasis: "CANONICAL_CURRENT_VS_EXTENDED_DELTA",
      additionalNights,
      currentCheckOut: reservation.checkOut,
      proposedCheckOut,
      currency: String(
        proposedCanonicalPricing.currency ??
          currentCanonicalPricing.currency ??
          reservation.currency ??
          "usd",
      ).toLowerCase(),
      historicalReservationTotal,
      currentCanonicalTotal,
      currentCanonicalTotalCents,
      proposedCanonicalTotal,
      proposedCanonicalTotalCents,
      amountDifference,
      amountDifferenceCents,
      additionalAmount: amountDifferenceCents > 0 ? amountDifference : null,
      additionalAmountCents:
        amountDifferenceCents > 0 ? amountDifferenceCents : null,
      extensionNightlyRates,
      pricingReviewRequired: amountDifferenceCents <= 0,
      chargeExecuted: false,
      reservationChanged: false,
      note:
        "Read-only canonical pricing delta only. No reservation change, approval, payment, or charge was executed.",
    };
  }

  private async getPropertyKnowledge(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const language: PropertyKnowledgeLanguage =
      request.context.preferredLanguage === "es" ? "es" : "en";

    return getPropertyKnowledgeSnapshot({
      prisma: this.prisma,
      organizationId: request.context.organizationId,
      propertyId: request.context.propertyId,
      reservationId: request.context.reservationId,
      currentDateTime: request.context.currentLocalDateTime,
      language,
    });
  }

  private async getReservationContext(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
        reservationNumber: true,
        propertyId: true,
        preferredLanguage: true,
        checkIn: true,
        checkOut: true,
        adults: true,
        children: true,
        status: true,
        source: true,
        paymentState: true,
        verificationStatus: true,
        identityVerificationRequiredSnapshot: true,
        stripeIdentityVerificationStatus: true,
        guestAgreementSignedAt: true,
        guestAccessReleaseStatus: true,
        guestAccessEligibleAt: true,
        guestAccessReleasedAt: true,
        guestAccessModeSnapshot: true,
        cancellationPolicySnapshot: true,
        cancelledAt: true,
        property: {
          select: {
            organizationId: true,
            timezone: true,
            checkInTime: true,
            checkOutTime: true,
            maxGuests: true,
          },
        },
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }

    return {
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        propertyId: reservation.propertyId,
        preferredLanguage: reservation.preferredLanguage,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        adults: reservation.adults,
        children: reservation.children,
        status: reservation.status,
        source: reservation.source,
        paymentState: reservation.paymentState,
        verificationStatus: reservation.verificationStatus,
        identityVerificationRequired:
          reservation.identityVerificationRequiredSnapshot,
        identityVerificationStatus:
          reservation.stripeIdentityVerificationStatus,
        guestAgreementSignedAt: reservation.guestAgreementSignedAt,
        guestAccessReleaseStatus: reservation.guestAccessReleaseStatus,
        guestAccessEligibleAt: reservation.guestAccessEligibleAt,
        guestAccessReleasedAt: reservation.guestAccessReleasedAt,
        guestAccessMode: reservation.guestAccessModeSnapshot,
        cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
        cancelledAt: reservation.cancelledAt,
      },
      property: {
        organizationId: reservation.property.organizationId,
        timezone: reservation.property.timezone,
        checkInTime: reservation.property.checkInTime,
        checkOutTime: reservation.property.checkOutTime,
        maxGuests: reservation.property.maxGuests,
      },
    };
  }

  private async getAccessStatus(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    await this.assertReservationScope(request);

    const grants = await this.prisma.accessGrant.findMany({
      where: {
        reservationId: request.context.reservationId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        method: true,
        status: true,
        startsAt: true,
        endsAt: true,
        type: true,
        lock: {
          select: {
            displayName: true,
            locationLabel: true,
            isActive: true,
          },
        },
      },
    });

    return {
      reservationId: request.context.reservationId,
      grants: grants.map((grant) => ({
        method: grant.method,
        status: grant.status,
        startsAt: grant.startsAt,
        endsAt: grant.endsAt,
        type: grant.type,
        lock: grant.lock
          ? {
              displayName: grant.lock.displayName,
              locationLabel: grant.lock.locationLabel,
              isActive: grant.lock.isActive,
            }
          : null,
      })),
    };
  }

  private async getGuestJourneyStatus(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const journey = await this.prisma.guestJourney.findFirst({
      where: {
        reservationId: request.context.reservationId,
        reservation: {
          propertyId: request.context.propertyId,
          property: {
            organizationId: request.context.organizationId,
          },
        },
      },
      select: {
        currentState: true,
        stateChangedAt: true,
        verificationCompletedAt: true,
        accessScheduledAt: true,
        readyForArrivalAt: true,
        stayActiveAt: true,
        checkoutDueAt: true,
        completedAt: true,
        cancelledAt: true,
        coordinationIntents: {
          where: {
            status: {
              in: [
                "PENDING",
                "CLAIMED",
                "WAITING_FOR_EVIDENCE",
                "RETRYABLE",
                "EXHAUSTED",
              ],
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
          take: 20,
          select: {
            intentType: true,
            targetEngine: true,
            status: true,
            lastAttemptAt: true,
            nextActionAt: true,
            exhaustedAt: true,
          },
        },
      },
    });

    if (!journey) {
      return {
        decision: "GUEST_JOURNEY_STATUS_UNAVAILABLE",
        journeyFound: false,
        authorizationGranted: false,
        requiresHumanReview: true,
        operationalWrites: false,
        actionsExecuted: false,
        note:
          "No canonical Guest Journey was found for the scoped reservation. No lifecycle state was inferred or changed.",
      };
    }

    const activeCoordination: readonly GuestJourneyCoordinationView[] =
      Array.isArray(journey.coordinationIntents)
        ? journey.coordinationIntents.map((intent: any) => ({
            intentType: String(intent.intentType ?? "UNKNOWN"),
            targetEngine: String(intent.targetEngine ?? "UNKNOWN"),
            status: String(intent.status ?? "UNKNOWN"),
            lastAttemptAt: intent.lastAttemptAt ?? null,
            nextActionAt: intent.nextActionAt ?? null,
            exhaustedAt: intent.exhaustedAt ?? null,
          }))
        : [];
    const exhaustedCount = activeCoordination.filter(
      (intent) => intent.status === "EXHAUSTED",
    ).length;
    const retryableCount = activeCoordination.filter(
      (intent) => intent.status === "RETRYABLE",
    ).length;
    const waitingCount = activeCoordination.filter((intent) =>
      ["PENDING", "CLAIMED", "WAITING_FOR_EVIDENCE"].includes(
        String(intent.status),
      ),
    ).length;

    return {
      decision: "GUEST_JOURNEY_STATUS_READ",
      journeyFound: true,
      currentState: journey.currentState,
      stateChangedAt: journey.stateChangedAt,
      nextExpectedMilestone: nextGuestJourneyMilestone(journey.currentState),
      milestones: {
        verificationCompletedAt: journey.verificationCompletedAt,
        accessScheduledAt: journey.accessScheduledAt,
        readyForArrivalAt: journey.readyForArrivalAt,
        stayActiveAt: journey.stayActiveAt,
        checkoutDueAt: journey.checkoutDueAt,
        completedAt: journey.completedAt,
        cancelledAt: journey.cancelledAt,
      },
      coordinationSummary: {
        activeCount: activeCoordination.length,
        waitingCount,
        retryableCount,
        exhaustedCount,
      },
      activeCoordination,
      authorizationGranted: false,
      requiresHumanReview: exhaustedCount > 0,
      operationalWrites: false,
      actionsExecuted: false,
      note:
        "Read-only canonical lifecycle status. No reconciliation, retry, escalation, or operational action was executed.",
    };
  }

  private async getCleaningStatus(
    request: PinAIRuntimeRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    await this.assertReservationScope(request);

    const confirmations = await this.prisma.cleaningConfirmation.findMany({
      where: {
        reservationId: request.context.reservationId,
        propertyId: request.context.propertyId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      reservationId: request.context.reservationId,
      propertyId: request.context.propertyId,
      latestStatus: confirmations[0]?.status ?? "NOT_REQUESTED",
      confirmations,
    };
  }

  private async assertReservationScope(
    request: PinAIRuntimeRequest,
  ): Promise<void> {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id: request.context.reservationId,
        propertyId: request.context.propertyId,
        property: {
          organizationId: request.context.organizationId,
        },
      },
      select: {
        id: true,
      },
    });

    if (!reservation) {
      throw new Error("PIN_AI_RUNTIME_RESERVATION_NOT_FOUND_OR_OUT_OF_SCOPE");
    }
  }
}

function toMoney(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function nextGuestJourneyMilestone(currentState: unknown): string | null {
  const milestones: Readonly<Record<string, string | null>> = {
    RESERVATION_CONFIRMED: "VERIFICATION_PENDING",
    VERIFICATION_PENDING: "VERIFICATION_COMPLETED",
    VERIFICATION_COMPLETED: "ACCESS_SCHEDULED",
    ACCESS_SCHEDULED: "READY_FOR_ARRIVAL",
    READY_FOR_ARRIVAL: "STAY_ACTIVE",
    STAY_ACTIVE: "CHECKOUT_DUE",
    CHECKOUT_DUE: "JOURNEY_COMPLETED",
    JOURNEY_COMPLETED: null,
    JOURNEY_CANCELLED: null,
  };

  return milestones[String(currentState)] ?? null;
}

function toPersistedMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toMoney(value);
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function finiteCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function localPlacesUnavailable(
  decision: string,
): Readonly<Record<string, unknown>> {
  return {
    decision,
    authorizationGranted: false,
    requiresHumanReview: false,
    places: [],
    externalReadPerformed: false,
    currentOpeningHoursVerified: false,
    currentPricesVerified: false,
    bookingExecuted: false,
    actionsExecuted: false,
  };
}

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const dateKey = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;

  const [year, month, day] = dateKey.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.toISOString().slice(0, 10) === dateKey ? dateKey : null;
}

function buildPropertyDate(
  dateKey: string,
  localTime: unknown,
  timezone: string,
): Date {
  const time =
    typeof localTime === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)
      ? localTime
      : "00:00";
  return fromZonedTime(`${dateKey}T${time}:00`, timezone);
}

function dateOnlyNightCount(checkInDate: string, checkOutDate: string): number {
  return Math.round(
    (Date.parse(`${checkOutDate}T00:00:00.000Z`) -
      Date.parse(`${checkInDate}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function dateChangeDenied(
  decision: string,
): Readonly<Record<string, unknown>> {
  return {
    decision,
    authorizationGranted: false,
    priceCalculated: false,
    chargeExecuted: false,
    refundExecuted: false,
    reservationChanged: false,
  };
}

const CANCELLATION_POLICY_TYPES = new Set([
  "FLEXIBLE",
  "MODERATE",
  "FIRM",
  "STRICT",
  "CUSTOM",
  "NON_REFUNDABLE",
]);
const CANCELLATION_REFUND_BASES = new Set([
  "TOTAL_AMOUNT",
  "NIGHTLY_SUBTOTAL",
  "NIGHTLY_PLUS_CLEANING",
  "CUSTOM",
]);
const CANCELLATION_NON_REFUNDABLE_SCENARIOS = new Set([
  "EARLY_DEPARTURE",
  "DELAYED_ARRIVAL",
  "REDUCED_NIGHTS",
  "WEATHER_RE_SCHEDULE",
  "OTHER",
]);

function parseCancellationPolicySnapshot(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Readonly<Record<string, unknown>>;
  const type = String(snapshot.type ?? "");
  const refundBasis = String(snapshot.refundBasis ?? "");
  const refundRules = Array.isArray(snapshot.refundRules)
    ? snapshot.refundRules.map(parseCancellationRefundRule)
    : [];
  const nonRefundableScenarios = Array.isArray(
    snapshot.nonRefundableScenarios,
  )
    ? snapshot.nonRefundableScenarios.map(String)
    : [];
  const booleanKeys = [
    "guestSelfCancellationEnabled",
    "autoRefundEligibleCancellations",
    "requireHostApprovalOutsidePolicy",
    "cleaningFeeRefundable",
    "amenitiesRefundable",
    "taxesRefundable",
  ] as const;
  const numericKeys = [
    "freeCancellationHoursBeforeCheckIn",
    "refundPercentBeforeDeadline",
    "refundPercentAfterDeadline",
  ] as const;

  if (
    typeof snapshot.name !== "string" ||
    !snapshot.name.trim() ||
    typeof snapshot.source !== "string" ||
    !CANCELLATION_POLICY_TYPES.has(type) ||
    !CANCELLATION_REFUND_BASES.has(refundBasis) ||
    !Array.isArray(snapshot.refundRules) ||
    refundRules.some((rule) => rule === null) ||
    !Array.isArray(snapshot.nonRefundableScenarios) ||
    nonRefundableScenarios.some(
      (scenario) => !CANCELLATION_NON_REFUNDABLE_SCENARIOS.has(scenario),
    ) ||
    booleanKeys.some((key) => typeof snapshot[key] !== "boolean") ||
    numericKeys.some((key) => !Number.isFinite(Number(snapshot[key]))) ||
    typeof snapshot.snapshotAt !== "string" ||
    Number.isNaN(Date.parse(snapshot.snapshotAt)) ||
    (snapshot.nonRefundableDiscountPercent != null &&
      (!Number.isFinite(Number(snapshot.nonRefundableDiscountPercent)) ||
        Number(snapshot.nonRefundableDiscountPercent) < 0 ||
        Number(snapshot.nonRefundableDiscountPercent) > 100))
  ) {
    return null;
  }

  const normalizedRules = refundRules.filter(
    (rule): rule is Readonly<Record<string, unknown>> => rule !== null,
  );
  if (
    normalizedRules.some(
      (rule) =>
        Number(rule.minHoursBeforeCheckIn) < 0 ||
        Number(rule.refundPercent) < 0 ||
        Number(rule.refundPercent) > 100,
    ) ||
    numericKeys.some((key) => Number(snapshot[key]) < 0) ||
    Number(snapshot.refundPercentBeforeDeadline) > 100 ||
    Number(snapshot.refundPercentAfterDeadline) > 100
  ) {
    return null;
  }

  return {
    policyId:
      typeof snapshot.policyId === "string" ? snapshot.policyId : null,
    name: snapshot.name.trim(),
    type,
    source: snapshot.source,
    guestSelfCancellationEnabled: snapshot.guestSelfCancellationEnabled,
    autoRefundEligibleCancellations:
      snapshot.autoRefundEligibleCancellations,
    requireHostApprovalOutsidePolicy:
      snapshot.requireHostApprovalOutsidePolicy,
    freeCancellationHoursBeforeCheckIn: Number(
      snapshot.freeCancellationHoursBeforeCheckIn,
    ),
    refundBasis,
    refundPercentBeforeDeadline: Number(
      snapshot.refundPercentBeforeDeadline,
    ),
    refundPercentAfterDeadline: Number(snapshot.refundPercentAfterDeadline),
    refundRules: normalizedRules,
    nonRefundableScenarios,
    guestFacingSummary:
      typeof snapshot.guestFacingSummary === "string"
        ? snapshot.guestFacingSummary
        : null,
    cleaningFeeRefundable: snapshot.cleaningFeeRefundable,
    amenitiesRefundable: snapshot.amenitiesRefundable,
    taxesRefundable: snapshot.taxesRefundable,
    nonRefundableDiscountPercent:
      snapshot.nonRefundableDiscountPercent == null
        ? null
        : Number(snapshot.nonRefundableDiscountPercent),
    description:
      typeof snapshot.description === "string" ? snapshot.description : null,
    snapshotAt: snapshot.snapshotAt,
  };
}

function parseCancellationRefundRule(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rule = value as Readonly<Record<string, unknown>>;
  const minHoursBeforeCheckIn = Number(rule.minHoursBeforeCheckIn);
  const refundPercent = Number(rule.refundPercent);
  if (
    !Number.isFinite(minHoursBeforeCheckIn) ||
    !Number.isFinite(refundPercent)
  ) {
    return null;
  }
  return {
    minHoursBeforeCheckIn,
    refundPercent,
    label:
      typeof rule.label === "string" && rule.label.trim()
        ? rule.label.trim()
        : `${refundPercent}% refund`,
    description:
      typeof rule.description === "string" ? rule.description : null,
  };
}

function serializeCancellationPolicySnapshot(
  snapshot: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    name: snapshot.name,
    type: snapshot.type,
    source: snapshot.source,
    snapshotAt: snapshot.snapshotAt,
    guestSelfCancellationEnabled: snapshot.guestSelfCancellationEnabled,
    autoRefundEligibleCancellations:
      snapshot.autoRefundEligibleCancellations,
    requireHostApprovalOutsidePolicy:
      snapshot.requireHostApprovalOutsidePolicy,
    freeCancellationHoursBeforeCheckIn:
      snapshot.freeCancellationHoursBeforeCheckIn,
    refundBasis: snapshot.refundBasis,
    refundPercentBeforeDeadline: snapshot.refundPercentBeforeDeadline,
    refundPercentAfterDeadline: snapshot.refundPercentAfterDeadline,
    refundRules: snapshot.refundRules,
    nonRefundableScenarios: snapshot.nonRefundableScenarios,
    guestFacingSummary: snapshot.guestFacingSummary,
    cleaningFeeRefundable: snapshot.cleaningFeeRefundable,
    amenitiesRefundable: snapshot.amenitiesRefundable,
    taxesRefundable: snapshot.taxesRefundable,
    nonRefundableDiscountPercent: snapshot.nonRefundableDiscountPercent,
    description: snapshot.description,
  };
}

async function calculateRuntimeExtensionPricing(
  input: Parameters<RuntimePricingCalculator>[0],
): ReturnType<RuntimePricingCalculator> {
  const moduleUrl = new URL(
    "../../services/direct-booking-pricing.service.js",
    import.meta.url,
  ).href;
  const pricingModule = (await import(moduleUrl)) as Readonly<{
    calculateDirectBookingPricing?: RuntimePricingCalculator;
  }>;

  if (typeof pricingModule.calculateDirectBookingPricing !== "function") {
    throw new Error("PIN_AI_RUNTIME_PRICING_ENGINE_UNAVAILABLE");
  }

  return pricingModule.calculateDirectBookingPricing(input);
}

async function evaluateRuntimeCancellationPolicy(
  input: Parameters<RuntimeCancellationPolicyEvaluator>[0],
): ReturnType<RuntimeCancellationPolicyEvaluator> {
  const moduleUrl = new URL(
    "../../services/cancellation-policy.service.js",
    import.meta.url,
  ).href;
  const policyModule = (await import(moduleUrl)) as Readonly<{
    evaluateCancellationPolicy?: RuntimeCancellationPolicyEvaluator;
  }>;

  if (typeof policyModule.evaluateCancellationPolicy !== "function") {
    throw new Error("PIN_AI_RUNTIME_CANCELLATION_POLICY_ENGINE_UNAVAILABLE");
  }

  return policyModule.evaluateCancellationPolicy(input);
}
