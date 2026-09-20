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

type RuntimeReadPrisma = Readonly<{
  property: Readonly<{
    findFirst(args: unknown): Promise<any>;
  }>;
  reservation: Readonly<{
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

export class PinGoRuntimeReadToolExecutor implements PinAIRuntimeToolExecutor {
  private readonly eligibility: PinGoRuntimeEligibilityChecks;

  constructor(
    private readonly prisma: RuntimeReadPrisma,
    private readonly calculatePricing: RuntimePricingCalculator =
      calculateRuntimeExtensionPricing,
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
      default:
        throw new Error(`PIN_AI_RUNTIME_READ_TOOL_NOT_IMPLEMENTED:${tool}`);
    }
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

    const currentTotalAmount = toMoney(reservation.totalAmount);
    if (currentTotalAmount === null || currentTotalAmount <= 0) {
      return {
        decision: "CURRENT_RESERVATION_TOTAL_UNAVAILABLE",
        authorizationGranted: false,
        priceCalculated: false,
        chargeExecuted: false,
        reservationChanged: false,
      };
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

    const pricing = await this.calculatePricing({
      propertyId: reservation.propertyId,
      checkIn: reservation.checkIn,
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
      throw new Error("PIN_AI_RUNTIME_EXTENSION_PRICE_INVALID");
    }

    const currentTotalAmountCents = Math.round(currentTotalAmount * 100);
    const amountDifferenceCents =
      proposedTotalAmountCents - currentTotalAmountCents;
    const amountDifference = amountDifferenceCents / 100;
    const extensionStartDateKey = reservation.checkOut
      .toISOString()
      .slice(0, 10);
    const extensionNightlyRates = Array.isArray(pricing.nightlyRates)
      ? pricing.nightlyRates
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

    return {
      decision:
        amountDifferenceCents > 0
          ? "PRICE_CALCULATED_FOR_REVIEW"
          : "PRICE_REQUIRES_HUMAN_REVIEW",
      authorizationGranted: false,
      priceCalculated: true,
      priceIsEstimate: true,
      additionalNights,
      currentCheckOut: reservation.checkOut,
      proposedCheckOut,
      currency: String(
        pricing.currency ?? reservation.currency ?? "usd",
      ).toLowerCase(),
      currentReservationTotal: currentTotalAmount,
      proposedReservationTotal: proposedTotalAmount,
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
        "Read-only estimate only. No reservation change, approval, payment, or charge was executed.",
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
        lastError: true,
        recoveryOperation: true,
        recoveryAttemptCount: true,
        recoveryExhaustedAt: true,
        lastAppliedAt: true,
        revokedReason: true,
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
        lastError: grant.lastError,
        recoveryOperation: grant.recoveryOperation,
        recoveryAttemptCount: grant.recoveryAttemptCount,
        recoveryExhaustedAt: grant.recoveryExhaustedAt,
        lastAppliedAt: grant.lastAppliedAt,
        revokedReason: grant.revokedReason,
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
