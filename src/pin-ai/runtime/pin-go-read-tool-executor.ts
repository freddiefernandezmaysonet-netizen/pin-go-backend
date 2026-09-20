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
    findMany(args: unknown): Promise<any[]>;
  }>;
}>;

export class PinGoRuntimeReadToolExecutor implements PinAIRuntimeToolExecutor {
  constructor(
    private readonly prisma: RuntimeReadPrisma,
  ) {}

  async execute(
    tool: PinAIRuntimeToolName,
    _args: Readonly<Record<string, unknown>>,
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
      default:
        throw new Error(`PIN_AI_RUNTIME_READ_TOOL_NOT_IMPLEMENTED:${tool}`);
    }
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
