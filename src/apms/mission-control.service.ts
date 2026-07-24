import { PrismaClient } from "@prisma/client";

import {
  APMS_ENGINE_IDS,
  normalizeApmsEngineId,
} from "./engine-operational-contract";
import type {
  ApmsEngineId,
  MissionControlEngineDependency,
  MissionControlEvidenceRef,
  MissionControlReadModelV1,
} from "./engine-operational-contract";
import {
  buildMissionControlReadModel,
} from "./mission-control-read-model";
import type {
  MissionControlEngineReadiness,
  MissionControlOperationalProjection,
} from "./mission-control-read-model";

const RECENT_RESOLUTION_WINDOW_MS =
  7 * 24 * 60 * 60 * 1000;

const MAX_RECENT_RESOLUTIONS = 100;
const MAX_ACTIVE_ISSUES = 250;

export class MissionControlOrganizationNotFoundError extends Error {
  readonly code =
    "MISSION_CONTROL_ORGANIZATION_NOT_FOUND";

  constructor(organizationId: string) {
    super(
      `Organization ${organizationId} was not found.`
    );

    this.name =
      "MissionControlOrganizationNotFoundError";
  }
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readMetadataValue(
  metadata: Record<string, unknown>,
  keys: string[]
) {
  for (const key of keys) {
    if (metadata[key] !== undefined) {
      return metadata[key];
    }
  }

  return undefined;
}

function readMetadataNumber(
  metadata: Record<string, unknown>,
  keys: string[]
) {
  const value = readMetadataValue(
    metadata,
    keys
  );

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function readMetadataBoolean(
  metadata: Record<string, unknown>,
  keys: string[]
) {
  const value = readMetadataValue(
    metadata,
    keys
  );

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return false;
}

function readMetadataDate(
  metadata: Record<string, unknown>,
  keys: string[]
) {
  const value = readMetadataValue(
    metadata,
    keys
  );

  if (!value) {
    return null;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(String(value));

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function hasEnvironmentValues(
  names: string[]
) {
  return names.every((name) =>
    Boolean(cleanText(process.env[name]))
  );
}

function dependency(input: {
  code: string;
  state:
    | "AVAILABLE"
    | "DEGRADED"
    | "UNAVAILABLE"
    | "NOT_APPLICABLE";
  summary: string;
  lastCheckedAt?: Date | string | null;
}): MissionControlEngineDependency {
  return {
    code: input.code,
    state: input.state,
    summary: input.summary,
    lastCheckedAt:
      input.lastCheckedAt ?? null,
  };
}

function buildReadiness(input: {
  organization: {
    publicBookingEnabled: boolean;
    stripeConnectAccountId: string | null;
    stripeConnectStatus: string;
    stripeConnectChargesEnabled: boolean;
    stripeConnectPayoutsEnabled: boolean;
    stripeConnectLastSyncedAt: Date | null;
    ttlockAuth: {
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: Date | null;
      updatedAt: Date;
    } | null;
    properties: Array<{
      id: string;
      cleaningNfcEnabled: boolean;
      distributionEnabled: boolean;
      dynamicPricingEnabled: boolean;
      autonomousPricingEnabled: boolean;
      baseNightlyRate: unknown;
      locks: Array<{
        id: string;
        deviceHealth: {
          id: string;
          lastSeenAt: Date | null;
          batteryLastSuccessfulAt: Date | null;
          gatewayLastSuccessfulAt: Date | null;
        } | null;
      }>;
      propertyStaff: Array<{
        staffMember: {
          isActive: boolean;
        };
      }>;
    }>;
    pmsConnections: Array<{
      id: string;
      status: string;
      provider: string;
      updatedAt: Date;
      listings: Array<{
        propertyId: string | null;
      }>;
    }>;
  };
  activeReservationCount: number;
  activeDirectBookingCount: number;
  auditEvidence: Map<
    ApmsEngineId,
    {
      lastSuccessAt: Date;
      evidenceRefs: MissionControlEvidenceRef[];
    }
  >;
}) {
  const activeProperties =
    input.organization.properties;

  const activeLocks = activeProperties.flatMap(
    (property) => property.locks
  );

  const cleaningProperties =
    activeProperties.filter(
      (property) =>
        property.cleaningNfcEnabled
    );

  const revenueProperties =
    activeProperties;

  const distributionProperties =
    activeProperties.filter(
      (property) =>
        property.distributionEnabled
    );

  const activePmsConnections =
    input.organization.pmsConnections.filter(
      (connection) =>
        connection.status === "ACTIVE"
    );

  const mappedDistributionPropertyIds =
    new Set(
      activePmsConnections.flatMap(
        (connection) =>
          connection.listings
            .map(
              (listing) =>
                listing.propertyId
            )
            .filter(
              (
                propertyId
              ): propertyId is string =>
                Boolean(propertyId)
            )
      )
    );

  const legacyTtlockConfigured =
    hasEnvironmentValues([
      "TTLOCK_CLIENT_ID",
      "TTLOCK_CLIENT_SECRET",
      "TTLOCK_USERNAME",
      "TTLOCK_PASSWORD_PLAIN",
    ]);

  const organizationTtlockConfigured =
    Boolean(
      cleanText(
        input.organization.ttlockAuth
          ?.accessToken
      ) ||
        cleanText(
          input.organization.ttlockAuth
            ?.refreshToken
        )
    );

  const ttlockConfigured =
    organizationTtlockConfigured ||
    legacyTtlockConfigured;

  const resendConfigured =
    hasEnvironmentValues([
      "RESEND_API_KEY",
    ]);

  const twilioConfigured =
    hasEnvironmentValues([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
    ]);

  const stripeConfigured =
    hasEnvironmentValues([
      "STRIPE_SECRET_KEY",
    ]);

  const accessApplicable =
    activeLocks.length > 0 ||
    input.activeReservationCount > 0;

  const accessConfigured =
    activeLocks.length > 0 &&
    ttlockConfigured;

  const deviceHealthApplicable =
    activeLocks.length > 0;

  const deviceHealthConfigured =
    deviceHealthApplicable &&
    ttlockConfigured;

  const cleaningApplicable =
    cleaningProperties.length > 0;

  const cleaningConfigured =
    cleaningApplicable &&
    accessConfigured &&
    cleaningProperties.every(
      (property) =>
        property.propertyStaff.some(
          (assignment) =>
            assignment.staffMember.isActive
        )
    );

  const distributionApplicable =
    distributionProperties.length > 0 ||
    activePmsConnections.length > 0;

  const distributionConfigured =
    distributionApplicable &&
    activePmsConnections.length > 0 &&
    distributionProperties.every(
      (property) =>
        mappedDistributionPropertyIds.has(
          property.id
        )
    );

  const revenueApplicable =
    revenueProperties.length > 0;

  const revenueConfigured =
    revenueApplicable &&
    revenueProperties.every(
      (property) =>
        property.baseNightlyRate !== null
    );

  const financialApplicable =
    input.organization
      .publicBookingEnabled ||
    input.activeDirectBookingCount > 0 ||
    Boolean(
      input.organization
        .stripeConnectAccountId
    );

  const stripeConnectReady =
    input.organization
      .stripeConnectStatus === "READY" &&
    input.organization
      .stripeConnectChargesEnabled &&
    input.organization
      .stripeConnectPayoutsEnabled;

  const financialConfigured =
    financialApplicable &&
    stripeConfigured &&
    Boolean(
      input.organization
        .stripeConnectAccountId
    ) &&
    stripeConnectReady;

  const ttlockDependency = dependency({
    code: "TTLOCK_AUTH",
    state: ttlockConfigured
      ? "AVAILABLE"
      : "DEGRADED",
    summary: ttlockConfigured
      ? "TTLock authentication is configured."
      : "TTLock authentication is not configured in the organization or legacy environment.",
    lastCheckedAt:
      input.organization.ttlockAuth
        ?.updatedAt ?? null,
  });

  const auditFor = (
    engineId: ApmsEngineId
  ) =>
    input.auditEvidence.get(engineId) ?? {
      lastSuccessAt: null,
      evidenceRefs: [],
    };

  const withAudit = (
    engineId: ApmsEngineId,
    readiness: Omit<
      MissionControlEngineReadiness,
      "lastSuccessAt" | "evidenceRefs"
    >
  ): MissionControlEngineReadiness => {
    const audit = auditFor(engineId);

    return {
      ...readiness,
      lastSuccessAt:
        audit.lastSuccessAt,
      evidenceRefs:
        audit.evidenceRefs,
    };
  };

  const readiness = {
    GUEST_JOURNEY: withAudit(
      "GUEST_JOURNEY",
      {
        enabled: true,
        configured: true,
        applicable:
          input.activeReservationCount > 0,
        reasonCode:
          input.activeReservationCount > 0
            ? "GUEST_JOURNEY_MONITORING_ACTIVE"
            : "GUEST_JOURNEY_NOT_APPLICABLE",
        summary:
          input.activeReservationCount > 0
            ? `Pin&Go is monitoring ${input.activeReservationCount} active guest journey${
                input.activeReservationCount === 1
                  ? ""
                  : "s"
              }.`
            : "No active reservation currently requires a guest journey.",
        staleAt: null,
        dependencies: [],
      }
    ),

    ACCESS: withAudit(
      "ACCESS",
      {
        enabled: true,
        configured: accessConfigured,
        applicable: accessApplicable,
        reasonCode: !accessApplicable
          ? "ACCESS_NOT_APPLICABLE"
          : accessConfigured
          ? "ACCESS_CONFIGURED"
          : "ACCESS_NOT_CONFIGURED",
        summary: !accessApplicable
          ? "No active lock or reservation currently requires the Access Engine."
          : accessConfigured
          ? "Access dependencies are configured."
          : "Access requires an active lock and TTLock authentication.",
        staleAt: null,
        dependencies: [
          ttlockDependency,
        ],
      }
    ),

    DEVICE_HEALTH: withAudit(
      "DEVICE_HEALTH",
      {
        enabled: true,
        configured:
          deviceHealthConfigured,
        applicable:
          deviceHealthApplicable,
        reasonCode:
          !deviceHealthApplicable
            ? "DEVICE_HEALTH_NOT_APPLICABLE"
            : deviceHealthConfigured
            ? "DEVICE_HEALTH_CONFIGURED"
            : "DEVICE_HEALTH_NOT_CONFIGURED",
        summary:
          !deviceHealthApplicable
            ? "No active lock currently requires device monitoring."
            : deviceHealthConfigured
            ? `${activeLocks.length} active lock${
                activeLocks.length === 1
                  ? " is"
                  : "s are"
              } eligible for device monitoring.`
            : "Device Health requires TTLock authentication.",
        staleAt: null,
        dependencies: [
          ttlockDependency,
        ],
      }
    ),

    COMMUNICATIONS: withAudit(
      "COMMUNICATIONS",
      {
        enabled: true,
        configured:
          resendConfigured ||
          twilioConfigured,
        applicable:
          activeProperties.length > 0,
        reasonCode:
          activeProperties.length === 0
            ? "COMMUNICATIONS_NOT_APPLICABLE"
            : resendConfigured ||
              twilioConfigured
            ? "COMMUNICATIONS_CONFIGURED"
            : "COMMUNICATIONS_NOT_CONFIGURED",
        summary:
          activeProperties.length === 0
            ? "No active property currently requires communications."
            : resendConfigured ||
              twilioConfigured
            ? "At least one communications provider is configured."
            : "Communications requires Resend or Twilio configuration.",
        staleAt: null,
        dependencies: [
          dependency({
            code: "RESEND",
            state: resendConfigured
              ? "AVAILABLE"
              : "DEGRADED",
            summary: resendConfigured
              ? "Email delivery is configured."
              : "Email delivery is not configured.",
          }),
          dependency({
            code: "TWILIO",
            state: twilioConfigured
              ? "AVAILABLE"
              : "DEGRADED",
            summary: twilioConfigured
              ? "SMS delivery is configured."
              : "SMS delivery is not configured.",
          }),
        ],
      }
    ),

    CLEANING: withAudit(
      "CLEANING",
      {
        enabled: cleaningApplicable,
        configured: cleaningConfigured,
        applicable: cleaningApplicable,
        reasonCode: !cleaningApplicable
          ? "CLEANING_DISABLED"
          : cleaningConfigured
          ? "CLEANING_CONFIGURED"
          : "CLEANING_NOT_CONFIGURED",
        summary: !cleaningApplicable
          ? "Cleaning NFC is disabled for all active properties."
          : cleaningConfigured
          ? "Cleaning assignments and cleaner access dependencies are configured."
          : "Cleaning requires active cleaner assignments and configured Access dependencies.",
        staleAt: null,
        dependencies: [
          dependency({
            code: "CLEANER_ASSIGNMENTS",
            state: cleaningConfigured
              ? "AVAILABLE"
              : "DEGRADED",
            summary: cleaningConfigured
              ? "Every enabled property has an active cleaner assignment."
              : "One or more enabled properties lack an active cleaner assignment or Access dependency.",
          }),
        ],
      }
    ),

    DISTRIBUTION_PMS: withAudit(
      "DISTRIBUTION_PMS",
      {
        enabled: distributionApplicable,
        configured:
          distributionConfigured,
        applicable:
          distributionApplicable,
        reasonCode:
          !distributionApplicable
            ? "DISTRIBUTION_PMS_DISABLED"
            : distributionConfigured
            ? "DISTRIBUTION_PMS_CONFIGURED"
            : "DISTRIBUTION_PMS_NOT_CONFIGURED",
        summary:
          !distributionApplicable
            ? "Distribution and PMS integrations are disabled."
            : distributionConfigured
            ? "Active PMS connections cover every distribution-enabled property."
            : "Distribution requires an active PMS connection and mapped listings.",
        staleAt: null,
        dependencies: [
          dependency({
            code: "PMS_CONNECTION",
            state:
              activePmsConnections.length > 0
                ? "AVAILABLE"
                : distributionApplicable
                ? "UNAVAILABLE"
                : "NOT_APPLICABLE",
            summary:
              activePmsConnections.length > 0
                ? `${activePmsConnections.length} active PMS connection${
                    activePmsConnections.length === 1
                      ? " is"
                      : "s are"
                  } configured.`
                : "No active PMS connection is configured.",
            lastCheckedAt:
              activePmsConnections[0]
                ?.updatedAt ?? null,
          }),
        ],
      }
    ),

    REVENUE: withAudit(
      "REVENUE",
      {
        enabled: revenueApplicable,
        configured: revenueConfigured,
        applicable: revenueApplicable,
        reasonCode: !revenueApplicable
          ? "REVENUE_NOT_APPLICABLE"
          : revenueConfigured
          ? "REVENUE_CONFIGURED"
          : "REVENUE_NOT_CONFIGURED",
        summary: !revenueApplicable
          ? "No active property currently requires revenue pricing."
          : revenueConfigured
          ? "Revenue pricing guardrails have a base nightly rate for every active property."
          : "Revenue requires a base nightly rate for every active property.",
        staleAt: null,
        dependencies: [
          dependency({
            code: "BASE_NIGHTLY_RATE",
            state: revenueConfigured
              ? "AVAILABLE"
              : revenueApplicable
              ? "UNAVAILABLE"
              : "NOT_APPLICABLE",
            summary: revenueConfigured
              ? "Every active property has a base nightly rate."
              : revenueApplicable
              ? "One or more active properties are missing a base nightly rate."
              : "Revenue pricing is not applicable.",
          }),
        ],
      }
    ),

    FINANCIAL: withAudit(
      "FINANCIAL",
      {
        enabled: financialApplicable,
        configured: financialConfigured,
        applicable: financialApplicable,
        reasonCode: !financialApplicable
          ? "FINANCIAL_NOT_APPLICABLE"
          : financialConfigured
          ? "FINANCIAL_CONFIGURED"
          : "FINANCIAL_NOT_CONFIGURED",
        summary: !financialApplicable
          ? "Direct Booking financial workflows are not applicable."
          : financialConfigured
          ? "Stripe and the host payout account are configured."
          : "Financial workflows require Stripe and a host payout account.",
        staleAt: null,
        dependencies: [
          dependency({
            code: "STRIPE_PLATFORM",
            state: stripeConfigured
              ? "AVAILABLE"
              : financialApplicable
              ? "UNAVAILABLE"
              : "NOT_APPLICABLE",
            summary: stripeConfigured
              ? "Stripe platform credentials are configured."
              : "Stripe platform credentials are not configured.",
          }),
          dependency({
            code: "STRIPE_CONNECT",
            state: stripeConnectReady
              ? "AVAILABLE"
              : financialApplicable
              ? "DEGRADED"
              : "NOT_APPLICABLE",
            summary: stripeConnectReady
              ? "The host payout account is ready."
              : `The host payout account is ${input.organization.stripeConnectStatus.toLowerCase().replace(/_/g, " ")}.`,
            lastCheckedAt:
              input.organization
                .stripeConnectLastSyncedAt,
          }),
        ],
      }
    ),
  } satisfies Record<
    ApmsEngineId,
    MissionControlEngineReadiness
  >;

  return readiness;
}

function buildAuditEvidence(
  rows: Array<{
    id: string;
    engine: string;
    completedAt: Date | null;
    createdAt: Date;
  }>
) {
  const evidence = new Map<
    ApmsEngineId,
    {
      lastSuccessAt: Date;
      evidenceRefs: MissionControlEvidenceRef[];
    }
  >();

  for (const row of rows) {
    const engineId = normalizeApmsEngineId(
      row.engine
    );

    if (!engineId || evidence.has(engineId)) {
      continue;
    }

    evidence.set(engineId, {
      lastSuccessAt:
        row.completedAt ?? row.createdAt,
      evidenceRefs: [
        {
          kind: "AUDIT_ENTRY",
          id: row.id,
        },
      ],
    });
  }

  return evidence;
}

export async function getOrganizationMissionControl(
  prisma: PrismaClient,
  organizationIdInput: string,
  now: Date = new Date()
): Promise<MissionControlReadModelV1> {
  const organizationId = cleanText(
    organizationIdInput
  );

  if (!organizationId) {
    throw new MissionControlOrganizationNotFoundError(
      String(organizationIdInput ?? "")
    );
  }

  const organization =
    await prisma.organization.findUnique({
      where: {
        id: organizationId,
      },
      select: {
        id: true,
        publicBookingEnabled: true,
        stripeConnectAccountId: true,
        stripeConnectStatus: true,
        stripeConnectChargesEnabled: true,
        stripeConnectPayoutsEnabled: true,
        stripeConnectLastSyncedAt: true,
        ttlockAuth: {
          select: {
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
            updatedAt: true,
          },
        },
        properties: {
          where: {
            status: "ACTIVE",
          },
          select: {
            id: true,
            cleaningNfcEnabled: true,
            distributionEnabled: true,
            dynamicPricingEnabled: true,
            autonomousPricingEnabled: true,
            baseNightlyRate: true,
            locks: {
              where: {
                isActive: true,
              },
              select: {
                id: true,
                deviceHealth: {
                  select: {
                    id: true,
                    lastSeenAt: true,
                    batteryLastSuccessfulAt: true,
                    gatewayLastSuccessfulAt: true,
                  },
                },
              },
            },
            propertyStaff: {
              where: {
                isActive: true,
              },
              select: {
                staffMember: {
                  select: {
                    isActive: true,
                  },
                },
              },
            },
          },
        },
        pmsConnections: {
          select: {
            id: true,
            status: true,
            provider: true,
            updatedAt: true,
            listings: {
              select: {
                propertyId: true,
              },
            },
          },
        },
      },
    });

  if (!organization) {
    throw new MissionControlOrganizationNotFoundError(
      organizationId
    );
  }

  const propertyIds =
    organization.properties.map(
      (property) => property.id
    );

  const recentlyResolvedSince = new Date(
    now.getTime() -
      RECENT_RESOLUTION_WINDOW_MS
  );

  const issueOwnershipWhere = {
    OR: [
      {
        organizationId,
      },
      {
        organizationId: null,
        propertyId: {
          in: propertyIds,
        },
      },
    ],
  } as const;

  const [
    activeReservationCount,
    activeDirectBookingCount,
    activeIssues,
    recentResolvedIssues,
    successfulAudits,
  ] = await Promise.all([
    prisma.reservation.count({
      where: {
        status: "ACTIVE",
        checkOut: {
          gt: now,
        },
        property: {
          organizationId,
        },
      },
    }),
    prisma.reservation.count({
      where: {
        status: "ACTIVE",
        checkOut: {
          gt: now,
        },
        property: {
          organizationId,
        },
        OR: [
          {
            source: "DIRECT_BOOKING",
          },
          {
            externalProvider:
              "PIN_GO_DIRECT",
          },
          {
            stripeCheckoutSessionId: {
              not: null,
            },
          },
        ],
      },
    }),
    prisma.operationalIssue.findMany({
      where: {
        ...issueOwnershipWhere,
        visibility: {
          in: ["HOST", "SYSTEM"],
        },
        workflowState: {
          not: "RESOLVED",
        },
      },
      orderBy: [
        {
          lastSignalAt: "desc",
        },
      ],
      take: MAX_ACTIVE_ISSUES,
      select: {
        id: true,
        issueCode: true,
        title: true,
        issue: true,
        engine: true,
        workflowState: true,
        actionRequired: true,
        responsibleActor: true,
        recommendedAction: true,
        nextAutomaticStep: true,
        actionTarget: true,
        reservationId: true,
        propertyId: true,
        guestName: true,
        cleanerName: true,
        lastSignalAt: true,
        resolvedAt: true,
        resolutionSummary: true,
        resolutionType: true,
        autoResolveAttemptCount: true,
        metadata: true,
      },
    }),
    prisma.operationalIssue.findMany({
      where: {
        ...issueOwnershipWhere,
        visibility: {
          in: ["HOST", "SYSTEM"],
        },
        workflowState: "RESOLVED",
        resolvedAt: {
          gte: recentlyResolvedSince,
        },
      },
      orderBy: [
        {
          resolvedAt: "desc",
        },
        {
          lastSignalAt: "desc",
        },
      ],
      take: MAX_RECENT_RESOLUTIONS,
      select: {
        id: true,
        issueCode: true,
        title: true,
        issue: true,
        engine: true,
        workflowState: true,
        actionRequired: true,
        responsibleActor: true,
        recommendedAction: true,
        nextAutomaticStep: true,
        actionTarget: true,
        reservationId: true,
        propertyId: true,
        guestName: true,
        cleanerName: true,
        lastSignalAt: true,
        resolvedAt: true,
        resolutionSummary: true,
        resolutionType: true,
        autoResolveAttemptCount: true,
        metadata: true,
      },
    }),
    prisma.apmsAuditEntry.findMany({
      where: {
        status: "SUCCESS",
        OR: [
          {
            organizationId,
          },
          {
            organizationId: null,
            propertyId: {
              in: propertyIds,
            },
          },
        ],
      },
      orderBy: [
        {
          completedAt: "desc",
        },
        {
          createdAt: "desc",
        },
      ],
      take: 200,
      select: {
        id: true,
        engine: true,
        completedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const issueRows = [
    ...activeIssues,
    ...recentResolvedIssues,
  ];

  const issueReservationIds = Array.from(
    new Set(
      issueRows
        .map((issue) =>
          cleanText(issue.reservationId)
        )
        .filter(
          (
            reservationId
          ): reservationId is string =>
            Boolean(reservationId)
        )
    )
  );

  const issueReservations =
    issueReservationIds.length > 0
      ? await prisma.reservation.findMany({
          where: {
            id: {
              in: issueReservationIds,
            },
            property: {
              organizationId,
            },
          },
          select: {
            id: true,
            reservationNumber: true,
            guestName: true,
            propertyId: true,
          },
        })
      : [];

  const reservationById = new Map(
    issueReservations.map((reservation) => [
      reservation.id,
      reservation,
    ])
  );

  const operationalItems:
    MissionControlOperationalProjection[] =
    issueRows.map((issue) => {
      const metadata = asRecord(
        issue.metadata
      );
      const reservation = issue.reservationId
        ? reservationById.get(
            issue.reservationId
          )
        : null;

      const metadataAttempt =
        readMetadataNumber(metadata, [
          "attempt",
          "attemptCount",
          "recoveryAttemptCount",
        ]);

      return {
        issueId: issue.id,
        issueCode: issue.issueCode,
        title: issue.title,
        issue: issue.issue,
        engine: issue.engine,
        workflowState:
          issue.workflowState,
        actionRequired:
          issue.actionRequired,
        responsibleActor:
          issue.responsibleActor,
        recommendedAction:
          issue.recommendedAction,
        nextAutomaticStep:
          issue.nextAutomaticStep,
        actionTarget:
          issue.actionTarget,
        reservationId:
          issue.reservationId,
        reservationNumber:
          reservation?.reservationNumber ??
          null,
        propertyId:
          issue.propertyId ??
          reservation?.propertyId ??
          null,
        guestName:
          reservation?.guestName ??
          issue.guestName,
        cleanerName:
          issue.cleanerName,
        lastSignalAt:
          issue.lastSignalAt,
        resolvedAt: issue.resolvedAt,
        resolutionSummary:
          issue.resolutionSummary,
        resolutionType:
          issue.resolutionType,
        nextAttemptAt:
          readMetadataDate(metadata, [
            "nextAttemptAt",
            "nextCheckAt",
            "recoveryNextAttemptAt",
          ]),
        attempt:
          metadataAttempt ??
          issue.autoResolveAttemptCount,
        maxAttempts:
          readMetadataNumber(metadata, [
            "maxAttempts",
            "maxTotalAttempts",
            "retryBudget",
          ]),
        exhausted:
          readMetadataBoolean(metadata, [
            "exhausted",
            "recoveryExhausted",
          ]) ||
          Boolean(
            readMetadataDate(metadata, [
              "exhaustedAt",
              "recoveryExhaustedAt",
            ])
          ),
      };
    });

  const readiness = buildReadiness({
    organization,
    activeReservationCount,
    activeDirectBookingCount,
    auditEvidence:
      buildAuditEvidence(
        successfulAudits
      ),
  });

  return buildMissionControlReadModel({
    organizationId,
    generatedAt: now,
    readiness,
    operationalItems,
  });
}
