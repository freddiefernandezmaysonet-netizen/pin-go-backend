import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  gatewayMonitoringModeFromPolicy,
  loadGatewayMonitoringPolicies,
  type GatewayMonitoringMode,
} from "../services/lockGatewayMonitoring.service";
import { effectiveTtlockGatewayHealth } from "../services/ttlock-gateway-read-model";

function isVisibleRisk(risk?: string | null) {
  return risk !== "HEALTHY";
}

function riskRank(risk?: string | null) {
  switch (risk) {
    case "CRITICAL":
      return 1;
    case "AT_RISK":
      return 2;
    case "WARNING":
      return 3;
    case "UNKNOWN":
      return 4;
    case "HEALTHY":
    default:
      return 5;
  }
}

function getOrgId(req: any): string | null {
  return req?.user?.orgId ?? null;
}

export function shouldShowHealthLock(input: {
  mode: GatewayMonitoringMode;
  gatewayConnected: boolean | null;
  operationalRisk?: string | null;
}) {
  return (
    input.mode !== "DISABLED" &&
    (
      input.gatewayConnected === false ||
      isVisibleRisk(input.operationalRisk)
    )
  );
}

function presentationForMode(input: {
  mode: GatewayMonitoringMode;
  operationalRisk?: string | null;
  operationalMessage?: string | null;
  recommendedAction?: string | null;
}) {
  if (input.mode === "DISABLED") {
    return {
      operationalRisk: "HEALTHY",
      operationalMessage:
        "Gateway monitoring is not enabled for this lock.",
      recommendedAction: null,
    };
  }

  if (input.mode === "LEGACY_UNCONFIGURED") {
    return {
      operationalRisk: "UNKNOWN",
      operationalMessage:
        "Gateway monitoring setup is required for this lock.",
      recommendedAction:
        "Open Locks and confirm whether a gateway is installed.",
    };
  }

  return {
    operationalRisk: input.operationalRisk ?? "UNKNOWN",
    operationalMessage: input.operationalMessage ?? null,
    recommendedAction: input.recommendedAction ?? null,
  };
}

export function buildDashboardHealthRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/summary", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          ttlockGateway: {
            select: {
              isOnline: true,
            },
          },
          deviceHealth: {
            select: {
              operationalRisk: true,
            },
          },
        },
      });

      const policies = await loadGatewayMonitoringPolicies(prisma, {
        organizationId: orgId,
        lockIds: locks.map((lock) => lock.id),
      });

      let healthy = 0;
      let warning = 0;
      let atRisk = 0;
      let critical = 0;
      let unknown = 0;
      let notMonitored = 0;
      let setupRequired = 0;
      let gatewayOffline = 0;
      let openAlerts = 0;

      for (const lock of locks) {
        const mode = gatewayMonitoringModeFromPolicy(
          policies.get(lock.id) ?? null
        );

        if (mode === "DISABLED") {
          notMonitored++;
          continue;
        }

        if (mode === "LEGACY_UNCONFIGURED") {
          setupRequired++;
          openAlerts++;
          continue;
        }

        const risk = lock.deviceHealth?.operationalRisk ?? "UNKNOWN";
        const canonicalGatewayOffline =
          lock.ttlockGateway?.isOnline === false;

        if (canonicalGatewayOffline) {
          gatewayOffline++;
        }

        if (canonicalGatewayOffline || risk !== "HEALTHY") {
          openAlerts++;
        }

        if (risk === "HEALTHY") {
          healthy++;
          continue;
        }

        if (risk === "WARNING") {
          warning++;
          continue;
        }

        if (risk === "AT_RISK") {
          atRisk++;
          continue;
        }

        if (risk === "CRITICAL") {
          critical++;
          continue;
        }

        unknown++;
      }

      res.json({
        ok: true,
        summary: {
          healthy,
          warning,
          atRisk,
          critical,
          unknown,
          notMonitored,
          setupRequired,
          gatewayOffline,
          openAlerts,
        },
      });
    } catch (err) {
      console.error("health summary error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to compute health summary",
      });
    }
  });

  router.get("/locks", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          locationLabel: true,
          updatedAt: true,
          property: {
            select: {
              id: true,
              name: true,
            },
          },
          ttlockGateway: {
            select: {
              ttlockGatewayId: true,
              isOnline: true,
              lastEventAt: true,
              source: true,
            },
          },
          deviceHealth: {
            select: {
              battery: true,
              isOnline: true,
              gatewayConnected: true,
              lastSeenAt: true,
              lastSyncAt: true,
              healthStatus: true,
              healthMessage: true,
              operationalRisk: true,
              operationalMessage: true,
              recommendedAction: true,
              nextCheckInAt: true,
              hasActiveAccess: true,
              riskCalculatedAt: true,
            },
          },
        },
      });

      const policies = await loadGatewayMonitoringPolicies(prisma, {
        organizationId: orgId,
        lockIds: locks.map((lock) => lock.id),
      });

      const items = locks
        .map((lock) => {
          const health = lock.deviceHealth;
          const mode = gatewayMonitoringModeFromPolicy(
            policies.get(lock.id) ?? null
          );
          const presentation = presentationForMode({
            mode,
            operationalRisk: health?.operationalRisk,
            operationalMessage: health?.operationalMessage,
            recommendedAction: health?.recommendedAction,
          });

          const name =
            lock.ttlockLockName ??
            lock.locationLabel ??
            `Lock ${lock.ttlockLockId}`;

          const gateway = effectiveTtlockGatewayHealth({
            canonicalOnline: lock.ttlockGateway?.isOnline,
            legacyConnected: health?.gatewayConnected,
            gatewayId: lock.ttlockGateway?.ttlockGatewayId,
            lastEventAt: lock.ttlockGateway?.lastEventAt,
          });

          return {
            id: lock.id,
            name,
            property: lock.property ?? null,
            gatewayMonitoringMode: mode,
            battery: mode === "DISABLED" ? null : health?.battery ?? null,
            isOnline: mode === "DISABLED" ? null : health?.isOnline ?? null,
            gatewayConnected:
              mode === "DISABLED" ? null : gateway.gatewayConnected,
            gatewayId:
              mode === "DISABLED" ? null : gateway.gatewayId,
            gatewayStateSource:
              mode === "DISABLED" ? null : gateway.gatewayStateSource,
            gatewayLastEventAt:
              mode === "DISABLED" ? null : gateway.gatewayLastEventAt,
            healthStatus:
              mode === "DISABLED"
                ? "NOT_MONITORED"
                : mode === "LEGACY_UNCONFIGURED"
                  ? "SETUP_REQUIRED"
                  : health?.healthStatus ?? "UNKNOWN",
            healthMessage: health?.healthMessage ?? null,
            operationalRisk: presentation.operationalRisk,
            operationalMessage: presentation.operationalMessage,
            recommendedAction: presentation.recommendedAction,
            nextCheckInAt: health?.nextCheckInAt ?? null,
            hasActiveAccess: health?.hasActiveAccess ?? false,
            lastSeenAt: health?.lastSeenAt ?? null,
            lastSyncAt: health?.lastSyncAt ?? null,
            riskCalculatedAt: health?.riskCalculatedAt ?? null,
            updatedAt: lock.updatedAt,
          };
        })
        .filter((item) =>
          shouldShowHealthLock({
            mode: item.gatewayMonitoringMode,
            gatewayConnected: item.gatewayConnected,
            operationalRisk: item.operationalRisk,
          })
        )
        .sort((a, b) => {
          const riskCompare =
            riskRank(a.operationalRisk) - riskRank(b.operationalRisk);

          if (riskCompare !== 0) return riskCompare;

          const aCheckIn = a.nextCheckInAt
            ? new Date(a.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          const bCheckIn = b.nextCheckInAt
            ? new Date(b.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          if (aCheckIn !== bCheckIn) return aCheckIn - bCheckIn;

          return (
            new Date(b.updatedAt).getTime() -
            new Date(a.updatedAt).getTime()
          );
        });

      res.json({
        ok: true,
        items,
      });
    } catch (err) {
      console.error("health locks error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to load health locks",
      });
    }
  });

  router.get("/control-tower", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          locationLabel: true,
          updatedAt: true,
          property: {
            select: {
              id: true,
              name: true,
            },
          },
          ttlockGateway: {
            select: {
              ttlockGatewayId: true,
              isOnline: true,
              lastEventAt: true,
              source: true,
            },
          },
          deviceHealth: {
            select: {
              battery: true,
              gatewayConnected: true,
              operationalRisk: true,
              operationalMessage: true,
              recommendedAction: true,
              nextCheckInAt: true,
            },
          },
        },
      });

      const policies = await loadGatewayMonitoringPolicies(prisma, {
        organizationId: orgId,
        lockIds: locks.map((lock) => lock.id),
      });

      const items = locks
        .map((lock) => {
          const health = lock.deviceHealth;
          const mode = gatewayMonitoringModeFromPolicy(
            policies.get(lock.id) ?? null
          );
          const presentation = presentationForMode({
            mode,
            operationalRisk: health?.operationalRisk,
            operationalMessage: health?.operationalMessage,
            recommendedAction: health?.recommendedAction,
          });

          const name =
            lock.ttlockLockName ??
            lock.locationLabel ??
            `Lock ${lock.ttlockLockId}`;

          const gateway = effectiveTtlockGatewayHealth({
            canonicalOnline: lock.ttlockGateway?.isOnline,
            legacyConnected: health?.gatewayConnected,
            gatewayId: lock.ttlockGateway?.ttlockGatewayId,
            lastEventAt: lock.ttlockGateway?.lastEventAt,
          });

          return {
            id: lock.id,
            name,
            property: lock.property ?? null,
            gatewayMonitoringMode: mode,
            battery: mode === "DISABLED" ? null : health?.battery ?? null,
            gatewayConnected:
              mode === "DISABLED" ? null : gateway.gatewayConnected,
            gatewayId:
              mode === "DISABLED" ? null : gateway.gatewayId,
            gatewayStateSource:
              mode === "DISABLED" ? null : gateway.gatewayStateSource,
            gatewayLastEventAt:
              mode === "DISABLED" ? null : gateway.gatewayLastEventAt,
            operationalRisk: presentation.operationalRisk,
            operationalMessage: presentation.operationalMessage,
            recommendedAction: presentation.recommendedAction,
            nextCheckInAt: health?.nextCheckInAt ?? null,
            updatedAt: lock.updatedAt,
          };
        })
        .filter((item) =>
          shouldShowHealthLock({
            mode: item.gatewayMonitoringMode,
            gatewayConnected: item.gatewayConnected,
            operationalRisk: item.operationalRisk,
          })
        )
        .sort((a, b) => {
          const riskCompare =
            riskRank(a.operationalRisk) - riskRank(b.operationalRisk);

          if (riskCompare !== 0) return riskCompare;

          const aCheckIn = a.nextCheckInAt
            ? new Date(a.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          const bCheckIn = b.nextCheckInAt
            ? new Date(b.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          if (aCheckIn !== bCheckIn) return aCheckIn - bCheckIn;

          return (
            new Date(b.updatedAt).getTime() -
            new Date(a.updatedAt).getTime()
          );
        })
        .slice(0, 5);

      res.json({
        ok: true,
        items,
      });
    } catch (err) {
      console.error("health control tower error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to load health control tower",
      });
    }
  });

  return router;
}
