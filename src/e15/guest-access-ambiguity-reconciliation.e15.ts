import { createHash } from "node:crypto";
import {
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  encryptAccessCode,
  hashAccessCode,
} from "../services/access-code-crypto.service";
import {
  assertGuestJourneyTenantPropertyScope,
  buildGuestJourneyCoordinationIntentScopeWhere,
  buildGuestJourneyReservationScopeWhere,
  type GuestJourneyTenantPropertyScope,
} from "../services/guest-journey-tenant-property-scope.policy";
import {
  GUEST_ACCESS_PROVISION_OPERATION,
} from "../e14/guest-access-admission-fence.policy.e14";
import type {
  GuestAccessAmbiguityE15Config,
} from "./guest-access-ambiguity-reconciliation.config.e15";
import {
  adoptProviderCredentialUnderReservationFenceE15_1,
  rearmAmbiguousGrantUnderReservationFenceE15_1,
  reconcileAccessIntentUnderReservationFenceE15_1,
} from "./guest-access-reservation-reconciliation-fence.e15-1";

export const GUEST_ACCESS_AMBIGUITY_E15_VERSION =
  "guest_access_ambiguity_reconciliation_e15_v1" as const;

export type ProviderPasscode = {
  keyboardPwdId: number;
  keyboardPwd: string;
  keyboardPwdName: string;
  keyboardPwdType: number;
  startDate: number;
  endDate: number;
  status: number;
};

export type ProviderInventory = {
  complete: boolean;
  fingerprint: string;
  pagesRead: number;
  items: ProviderPasscode[];
};

export type ProviderInventoryClassification =
  | { kind: "EXACT_MATCH"; item: ProviderPasscode }
  | { kind: "CONFLICT"; reason: string }
  | { kind: "ABSENT" }
  | { kind: "INCOMPLETE"; reason: string };

type E15Marker = {
  version: typeof GUEST_ACCESS_AMBIGUITY_E15_VERSION;
  state:
    | "ABSENCE_OBSERVED"
    | "CONFIRMED_ABSENT_REARMABLE"
    | "REARMED"
    | "RECONCILED_PRESENT"
    | "MANUAL_REVIEW_REQUIRED"
    | "VERIFYING_PROVIDER_STATE";
  inventoryFingerprint?: string;
  observedAt?: string;
  observationCount?: number;
  reason?: string;
};

function normalizeProviderItem(value: any): ProviderPasscode | null {
  const keyboardPwdId = Number(value?.keyboardPwdId);
  const keyboardPwd = String(value?.keyboardPwd ?? "").trim();
  const keyboardPwdName = String(value?.keyboardPwdName ?? "").trim();
  const keyboardPwdType = Number(value?.keyboardPwdType);
  const startDate = Number(value?.startDate);
  const endDate = Number(value?.endDate);
  const status = Number(value?.status);
  if (
    !Number.isFinite(keyboardPwdId) || keyboardPwdId <= 0 ||
    !Number.isFinite(keyboardPwdType) ||
    !Number.isFinite(startDate) || !Number.isFinite(endDate) ||
    !Number.isFinite(status)
  ) {
    return null;
  }
  return {
    keyboardPwdId,
    keyboardPwd,
    keyboardPwdName,
    keyboardPwdType,
    startDate,
    endDate,
    status,
  };
}

function inventoryFingerprint(items: ProviderPasscode[]): string {
  const normalized = [...items]
    .sort((a, b) => a.keyboardPwdId - b.keyboardPwdId)
    .map((item) => ({
      keyboardPwdId: item.keyboardPwdId,
      keyboardPwdName: item.keyboardPwdName,
      keyboardPwdType: item.keyboardPwdType,
      startDate: item.startDate,
      endDate: item.endDate,
      status: item.status,
    }));
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

export async function listTtlockPasscodesReadOnly(input: {
  lockId: number;
  accessToken: string;
  clientId: string;
  apiBase?: string;
  pageSize: number;
  maxPages: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ProviderInventory> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const items: ProviderPasscode[] = [];
  let complete = false;
  let pagesRead = 0;

  for (let pageNo = 1; pageNo <= input.maxPages; pageNo += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const url = new URL(
        "/v3/lock/listKeyboardPwd",
        input.apiBase ?? process.env.TTLOCK_API_BASE ?? "https://api.sciener.com"
      );
      url.searchParams.set("clientId", input.clientId);
      url.searchParams.set("accessToken", input.accessToken);
      url.searchParams.set("lockId", String(input.lockId));
      url.searchParams.set("pageNo", String(pageNo));
      url.searchParams.set("pageSize", String(input.pageSize));
      url.searchParams.set("date", String(Date.now()));

      const response = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`E15_TTLOCK_READ_HTTP_${response.status}`);
      }
      const payload = await response.json() as any;
      if (payload?.errcode) {
        throw new Error(`E15_TTLOCK_READ_ERR_${String(payload.errcode)}`);
      }
      const page = Array.isArray(payload?.list) ? payload.list : [];
      for (const raw of page) {
        const item = normalizeProviderItem(raw);
        if (item) items.push(item);
      }
      pagesRead = pageNo;

      const pages = Number(payload?.pages);
      const total = Number(payload?.total);
      if (Number.isFinite(pages) && pages > 0 && pageNo >= pages) {
        complete = true;
        break;
      }
      if (Number.isFinite(total) && total >= 0 && items.length >= total) {
        complete = true;
        break;
      }
      if (page.length < input.pageSize) {
        complete = true;
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    complete,
    fingerprint: inventoryFingerprint(items),
    pagesRead,
    items,
  };
}

export function classifyProviderInventory(input: {
  inventory: ProviderInventory;
  expectedName: string;
  startsAt: Date;
  endsAt: Date;
}): ProviderInventoryClassification {
  if (!input.inventory.complete) {
    return { kind: "INCOMPLETE", reason: "PROVIDER_INVENTORY_INCOMPLETE" };
  }

  const startMs = input.startsAt.getTime();
  const endMs = input.endsAt.getTime();
  const exact = input.inventory.items.filter((item) =>
    item.keyboardPwdName === input.expectedName &&
    item.keyboardPwdType === 3 &&
    item.startDate === startMs &&
    item.endDate === endMs &&
    item.status === 1 &&
    Boolean(item.keyboardPwd)
  );
  if (exact.length === 1) return { kind: "EXACT_MATCH", item: exact[0] };
  if (exact.length > 1) return { kind: "CONFLICT", reason: "MULTIPLE_EXACT_PROVIDER_MATCHES" };

  const correlated = input.inventory.items.filter((item) =>
    item.keyboardPwdName === input.expectedName ||
    (item.keyboardPwdType === 3 && item.startDate === startMs && item.endDate === endMs)
  );
  if (correlated.length > 0) {
    return { kind: "CONFLICT", reason: "CORRELATED_PROVIDER_EVIDENCE_CONFLICT" };
  }
  return { kind: "ABSENT" };
}

function expectedPasscodeName(reservationNumber: string | null): string {
  return reservationNumber
    ? `PinGo ${reservationNumber}`.slice(0, 30)
    : "PinGo Guest";
}

function markerFromPayload(payload: unknown): E15Marker | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const marker = (payload as any).e15;
  if (!marker || marker.version !== GUEST_ACCESS_AMBIGUITY_E15_VERSION) return null;
  return marker as E15Marker;
}

function withMarker(payload: unknown, marker: E15Marker): Prisma.InputJsonValue {
  const base = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return {
    ...base,
    e15: marker,
  } as Prisma.InputJsonValue;
}

export function nextAbsenceMarker(input: {
  previous: E15Marker | null;
  inventoryFingerprint: string;
  now: Date;
  minSeparationMs: number;
}): E15Marker {
  const previousAt = input.previous?.observedAt
    ? new Date(input.previous.observedAt)
    : null;
  const sameFingerprint =
    input.previous?.inventoryFingerprint === input.inventoryFingerprint;
  const separated = Boolean(
    previousAt &&
    !Number.isNaN(previousAt.getTime()) &&
    input.now.getTime() - previousAt.getTime() >= input.minSeparationMs
  );
  const previousCount = sameFingerprint
    ? Number(input.previous?.observationCount ?? 0)
    : 0;
  const observationCount = separated
    ? previousCount + 1
    : Math.max(previousCount, 1);
  return {
    version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,
    state: observationCount >= 2
      ? "CONFIRMED_ABSENT_REARMABLE"
      : "ABSENCE_OBSERVED",
    inventoryFingerprint: input.inventoryFingerprint,
    observedAt: input.now.toISOString(),
    observationCount,
  };
}

export function controlledRearmPrerequisites(input: {
  configured: boolean;
  e14Enabled: boolean;
  accessOwnerEnabled: boolean;
}): boolean {
  return input.configured && input.e14Enabled && input.accessOwnerEnabled;
}

function maskCode(code: string): string {
  if (code.length <= 2) return "**";
  return `${code.slice(0, 2)}*****`;
}

function intentOutcomeFingerprint(input: {
  intentId: string;
  grantId: string;
  keyboardPwdId: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

export type GuestAccessAmbiguityE15Metrics = {
  enabled: boolean;
  scannedGrants: number;
  providerReads: number;
  reconciledPresent: number;
  absenceObserved: number;
  confirmedAbsent: number;
  rearmedGrants: number;
  rearmedIntents: number;
  reconciledIntents: number;
  manualReview: number;
  providerReadFailures: number;
  races: number;
  durationMs: number;
  externalMutations: 0;
};

export async function runGuestAccessAmbiguityReconciliationCycle(
  prisma: PrismaClient,
  input: {
    config: GuestAccessAmbiguityE15Config;
    scope: GuestJourneyTenantPropertyScope;
    e14Enabled: boolean;
    accessOwnerEnabled: boolean;
    now?: Date;
    fetchImpl?: typeof fetch;
  }
): Promise<GuestAccessAmbiguityE15Metrics> {
  const startedAt = Date.now();
  const metrics: GuestAccessAmbiguityE15Metrics = {
    enabled: input.config.enabled,
    scannedGrants: 0,
    providerReads: 0,
    reconciledPresent: 0,
    absenceObserved: 0,
    confirmedAbsent: 0,
    rearmedGrants: 0,
    rearmedIntents: 0,
    reconciledIntents: 0,
    manualReview: 0,
    providerReadFailures: 0,
    races: 0,
    durationMs: 0,
    externalMutations: 0,
  };
  if (!input.config.enabled) {
    metrics.durationMs = Date.now() - startedAt;
    return metrics;
  }

  assertGuestJourneyTenantPropertyScope({
    enabled: true,
    scope: input.scope,
    errorCode: "GUEST_JOURNEY_E15_TENANT_SCOPE_REQUIRED",
  });

  const now = input.now ?? new Date();
  const reservationScope = buildGuestJourneyReservationScopeWhere(input.scope);
  const grants = await prisma.accessGrant.findMany({
    where: {
      type: "GUEST",
      method: AccessMethod.PASSCODE_TIMEBOUND,
      status: AccessStatus.PENDING,
      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
      reservation: {
        is: {
          ...reservationScope,
          status: ReservationStatus.ACTIVE,
          paymentState: PaymentState.PAID,
          guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
          checkOut: { gt: now },
        },
      },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: input.config.batchSize,
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      updatedAt: true,
      recoveryOperation: true,
      recoveryAttemptCount: true,
      recoveryLastAttemptAt: true,
      recoveryNextAttemptAt: true,
      recoveryExhaustedAt: true,
      lastError: true,
      ttlockPayload: true,
      lock: { select: { ttlockLockId: true } },
      reservation: {
        select: {
          id: true,
          reservationNumber: true,
          guestPhone: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });
  metrics.scannedGrants = grants.length;

  for (const grant of grants) {
    if (!grant.reservation) {
      metrics.manualReview += 1;
      continue;
    }
    const reservation = grant.reservation;
    const organizationId = reservation.property.organizationId;
    const ttlockLockId = Number(grant.lock.ttlockLockId);
    if (!organizationId || !Number.isFinite(ttlockLockId) || ttlockLockId <= 0) {
      metrics.manualReview += 1;
      continue;
    }

    const auth = await prisma.tTLockAuth.findUnique({
      where: { organizationId },
      select: { accessToken: true, expiresAt: true },
    });
    const clientId = String(process.env.TTLOCK_CLIENT_ID ?? "").trim();
    if (
      !auth?.accessToken ||
      !auth.expiresAt ||
      auth.expiresAt.getTime() <= now.getTime() ||
      !clientId
    ) {
      metrics.providerReadFailures += 1;
      continue;
    }

    let inventory: ProviderInventory;
    try {
      metrics.providerReads += 1;
      inventory = await listTtlockPasscodesReadOnly({
        lockId: ttlockLockId,
        accessToken: auth.accessToken,
        clientId,
        pageSize: input.config.providerPageSize,
        maxPages: input.config.providerMaxPages,
        timeoutMs: input.config.providerTimeoutMs,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch {
      metrics.providerReadFailures += 1;
      continue;
    }

    const classification = classifyProviderInventory({
      inventory,
      expectedName: expectedPasscodeName(reservation.reservationNumber),
      startsAt: grant.startsAt,
      endsAt: grant.endsAt,
    });

    if (classification.kind === "INCOMPLETE" || classification.kind === "CONFLICT") {
      const marker: E15Marker = {
        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,
        state: classification.kind === "INCOMPLETE"
          ? "VERIFYING_PROVIDER_STATE"
          : "MANUAL_REVIEW_REQUIRED",
        inventoryFingerprint: inventory.fingerprint,
        observedAt: now.toISOString(),
        reason: classification.reason,
      };
      const updated = await prisma.accessGrant.updateMany({
        where: {
          id: grant.id,
          status: AccessStatus.PENDING,
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryAttemptCount: grant.recoveryAttemptCount,
          updatedAt: grant.updatedAt,
        },
        data: { ttlockPayload: withMarker(grant.ttlockPayload, marker) },
      });
      if (updated.count !== 1) metrics.races += 1;
      else if (classification.kind === "CONFLICT") metrics.manualReview += 1;
      continue;
    }

    if (classification.kind === "EXACT_MATCH") {
      const item = classification.item;
      const code = item.keyboardPwd.trim();
      const encrypted = encryptAccessCode(code);
      const hashed = hashAccessCode(code);
      const masked = maskCode(code);
      const payload = withMarker(grant.ttlockPayload, {
        version: GUEST_ACCESS_AMBIGUITY_E15_VERSION,
        state: "RECONCILED_PRESENT",
        inventoryFingerprint: inventory.fingerprint,
        observedAt: now.toISOString(),
      });

      let adopted = false;
      try {
        adopted =
          await adoptProviderCredentialUnderReservationFenceE15_1(
            prisma,
            {
              grantId: grant.id,
              reservationId: reservation.id,
              organizationId,
              propertyId: reservation.propertyId,
              startsAt: grant.startsAt,
              endsAt: grant.endsAt,
              updatedAt: grant.updatedAt,
              recoveryAttemptCount: grant.recoveryAttemptCount,
              ttlockLockId,
              now,
              keyboardPwdId: item.keyboardPwdId,
              code,
              maskedCode: masked,
              encryptedCode: encrypted,
              hashedCode: hashed,
              payload,
              guestPhone: reservation.guestPhone ?? null,
            }
          );
      } catch {
        metrics.races += 1;
        continue;
      }
      if (adopted) metrics.reconciledPresent += 1;
      else metrics.races += 1;
      continue;
    }

    const absence = nextAbsenceMarker({
      previous: markerFromPayload(grant.ttlockPayload),
      inventoryFingerprint: inventory.fingerprint,
      now,
      minSeparationMs: input.config.absenceConfirmationMinMs,
    });
    if (absence.state === "ABSENCE_OBSERVED") {
      const updated = await prisma.accessGrant.updateMany({
        where: {
          id: grant.id,
          status: AccessStatus.PENDING,
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryAttemptCount: grant.recoveryAttemptCount,
          updatedAt: grant.updatedAt,
        },
        data: { ttlockPayload: withMarker(grant.ttlockPayload, absence) },
      });
      if (updated.count === 1) metrics.absenceObserved += 1;
      else metrics.races += 1;
      continue;
    }

    metrics.confirmedAbsent += 1;
    const canRearm = controlledRearmPrerequisites({
      configured: input.config.controlledRearmEnabled,
      e14Enabled: input.e14Enabled,
      accessOwnerEnabled: input.accessOwnerEnabled,
    });
    if (!canRearm) {
      const updated = await prisma.accessGrant.updateMany({
        where: {
          id: grant.id,
          status: AccessStatus.PENDING,
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryAttemptCount: grant.recoveryAttemptCount,
          updatedAt: grant.updatedAt,
        },
        data: { ttlockPayload: withMarker(grant.ttlockPayload, absence) },
      });
      if (updated.count !== 1) metrics.races += 1;
      continue;
    }

    const rearmedMarker: E15Marker = {
      ...absence,
      state: "REARMED",
      reason: "CONFIRMED_PROVIDER_ABSENCE",
    };
    let rearmed = false;
    try {
      rearmed =
        await rearmAmbiguousGrantUnderReservationFenceE15_1(
          prisma,
          {
            grantId: grant.id,
            reservationId: reservation.id,
            organizationId,
            propertyId: reservation.propertyId,
            startsAt: grant.startsAt,
            endsAt: grant.endsAt,
            updatedAt: grant.updatedAt,
            recoveryAttemptCount: grant.recoveryAttemptCount,
            ttlockLockId,
            now,
            payload: withMarker(grant.ttlockPayload, rearmedMarker),
          }
        );
    } catch {
      metrics.races += 1;
      continue;
    }
    if (rearmed) metrics.rearmedGrants += 1;
    else metrics.races += 1;
  }

  const intents = await prisma.guestJourneyCoordinationIntent.findMany({
    where: {
      targetEngine: "ACCESS",
      intentType: "REQUEST_ACCESS_PROVISIONING",
      status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
      lastError: { contains: "AMBIGUOUS" },
      AND: [buildGuestJourneyCoordinationIntentScopeWhere(input.scope)],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: input.config.batchSize,
    select: {
      id: true,
      status: true,
      claimCount: true,
      updatedAt: true,
      lastError: true,
      reservation: {
        select: {
          id: true,
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });

  const intentRearmAllowed = controlledRearmPrerequisites({
    configured: input.config.controlledRearmEnabled,
    e14Enabled: input.e14Enabled,
    accessOwnerEnabled: input.accessOwnerEnabled,
  });

  for (const intent of intents) {
    let reconciliation;
    try {
      reconciliation =
        await reconcileAccessIntentUnderReservationFenceE15_1(
          prisma,
          {
            intentId: intent.id,
            reservationId: intent.reservation.id,
            organizationId:
              intent.reservation.property.organizationId,
            propertyId: intent.reservation.propertyId,
            claimCount: intent.claimCount,
            updatedAt: intent.updatedAt,
            lastError: intent.lastError,
            controlledRearmEnabled: intentRearmAllowed,
            scope: input.scope,
            now,
          }
        );
    } catch {
      metrics.races += 1;
      continue;
    }

    if (reconciliation.action === "SUCCEEDED") {
      metrics.reconciledIntents += 1;
    } else if (reconciliation.action === "REARMED") {
      metrics.rearmedIntents += 1;
    }
  }

  metrics.durationMs = Date.now() - startedAt;
  return metrics;
}
