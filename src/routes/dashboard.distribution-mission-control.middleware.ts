import { Router } from "express";
import { getDistributionLifecycleSnapshot } from "../apms/distribution-lifecycle-read-model.service";

export const dashboardDistributionMissionControlMiddleware = Router();

type DistributionLifecycleSnapshot = Awaited<
  ReturnType<typeof getDistributionLifecycleSnapshot>
>;

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

export function toMissionControlDistributionView(
  snapshot: DistributionLifecycleSnapshot
) {
  const revisionItems = snapshot.revisions.map((revision) => ({
    reference:
      revision.otaReservationCode ??
      revision.bookingReference ??
      revision.revisionId,
    persistenceStatus: revision.persistenceStatus,
    acknowledgementStatus: revision.acknowledgementStatus,
    eventStatus: revision.eventStatus,
    attempts: revision.attempts,
    errorCode: revision.errorCode,
    recoverable: revision.recoverable,
    hostActionRequired: revision.hostActionRequired,
    nextAutomaticAction: revision.nextAutomaticAction,
    insertedAt: revision.insertedAt,
    lastUpdatedAt: revision.lastUpdatedAt,
  }));

  const unresolvedItems = snapshot.unresolvedEvents.map((event) => ({
    reference: event.revisionId ?? event.eventType,
    persistenceStatus: "PENDING" as const,
    acknowledgementStatus: "PENDING" as const,
    eventStatus: event.eventStatus,
    attempts: event.attempts,
    errorCode: event.errorCode,
    recoverable: event.recoverable,
    hostActionRequired: event.hostActionRequired,
    nextAutomaticAction: event.nextAutomaticAction,
    insertedAt: null,
    lastUpdatedAt: event.updatedAt,
  }));

  const pendingItems = [...revisionItems, ...unresolvedItems].filter(
    (item) =>
      item.recoverable ||
      item.hostActionRequired ||
      item.nextAutomaticAction === "RECOVERY_EXHAUSTED" ||
      item.persistenceStatus === "PENDING" ||
      item.acknowledgementStatus !== "SENT"
  );

  const automaticRecoveryItems = pendingItems.filter(
    (item) => item.recoverable && !item.hostActionRequired
  );

  const actionRequiredItems = pendingItems.filter(
    (item) =>
      item.hostActionRequired ||
      item.nextAutomaticAction === "RECOVERY_EXHAUSTED"
  );

  return {
    provider: snapshot.provider,
    connected: snapshot.connected,
    connectionStatus: snapshot.connectionStatus,
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    automaticRecovery: {
      active: automaticRecoveryItems.length > 0,
      itemCount: automaticRecoveryItems.length,
      nextActions: uniqueStrings(
        automaticRecoveryItems.map((item) => item.nextAutomaticAction)
      ),
      items: automaticRecoveryItems,
    },
    actionRequired: {
      active: actionRequiredItems.length > 0,
      itemCount: actionRequiredItems.length,
      items: actionRequiredItems,
    },
  };
}

dashboardDistributionMissionControlMiddleware.get(
  "/api/dashboard/properties/:id/mission-control",
  (req, res, next) => {
    const propertyId = String(req.params.id ?? "").trim();
    const originalJson = res.json.bind(res);
    let responseCommitted = false;

    res.json = ((body: any) => {
      if (responseCommitted) {
        return originalJson(body);
      }

      responseCommitted = true;

      if (
        res.statusCode >= 400 ||
        body?.ok !== true ||
        !body?.item ||
        !propertyId
      ) {
        return originalJson(body);
      }

      void (async () => {
        const organizationId = String(
          (req as any).user?.orgId ?? ""
        ).trim();

        if (!organizationId) {
          return originalJson(body);
        }

        try {
          const snapshot = await getDistributionLifecycleSnapshot({
            organizationId,
            propertyId,
          });

          return originalJson({
            ...body,
            item: {
              ...body.item,
              distributionLifecycle:
                toMissionControlDistributionView(snapshot),
            },
          });
        } catch (error: any) {
          console.error(
            "[MISSION_CONTROL_DISTRIBUTION_LIFECYCLE_READ_FAILED]",
            {
              propertyId,
              error: String(error?.message ?? error),
            }
          );

          return originalJson({
            ...body,
            item: {
              ...body.item,
              distributionLifecycle: {
                provider: "PIN_GO_CONNECT",
                connected: null,
                connectionStatus: "UNAVAILABLE",
                generatedAt: new Date().toISOString(),
                summary: null,
                automaticRecovery: {
                  active: false,
                  itemCount: 0,
                  nextActions: [],
                  items: [],
                },
                actionRequired: {
                  active: false,
                  itemCount: 0,
                  items: [],
                },
              },
            },
          });
        }
      })();

      return res;
    }) as typeof res.json;

    next();
  }
);
