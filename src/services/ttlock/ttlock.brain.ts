import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  Prisma,
 } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { isInternalDemo } from "../internal-demo-scope";
import {
  ttlockDeletePasscode,
} from "../../ttlock/ttlock.passcode";
import { provisionGuestPasscode } from "../guest-passcode-provision.service";
import { getOrgTtlockAccessToken } from "./ttlock.org-auth";
import { assertGuestAccessReady } from "../guest-access-readiness.service";
import {
  assertAccessCodeEncryptionConfigured,
  decryptAccessCode,
  encryptAccessCode,
  hashAccessCode,
} from "../access-code-crypto.service";

function maskCode(code: string) {
  if (code.length <= 4) return "****";
  return `${code.slice(0, 2)}*****`;
}

async function resolveGrantAccessToken(propertyId?: string | null) {
  if (!propertyId) {
    throw new Error("TTLOCK_PROPERTY_ID_MISSING");
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true },
  });

  if (!property?.organizationId) {
    throw new Error("TTLOCK_ORGANIZATION_ID_MISSING");
  }

  return getOrgTtlockAccessToken(
    prisma,
    property.organizationId
  );
}

export async function activateGrant(grantId: string) {
  const scope = await prisma.accessGrant.findUnique({ where: { id: grantId }, select: { lockId: true } });
  if (!scope) throw new Error("ACCESS_GRANT_NOT_FOUND");
  // Also protects callers outside E14 and two reservations choosing the same
  // phone suffix. State writes use prisma so they survive an uncertain request.
  return prisma.$transaction(async tx => {
    const [claim] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`guest-passcode:${scope.lockId}`}, 0)) AS acquired`;
    if (!claim?.acquired) throw new Error("GUEST_ACCESS_PROVISION_SAFE_TO_RETRY:LOCK_PROVISIONING_BUSY");
    return activateGrantUnderLock(grantId);
  }, { timeout: 60_000, maxWait: 5_000 });
}

async function activateGrantUnderLock(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
      reservation: { include: { property: true } },
    },
  });

  if (!grant) {
    throw new Error("ACCESS_GRANT_NOT_FOUND");
  }

  if (grant.status !== AccessStatus.PENDING) {
    return {
      skipped: true,
      reason: `GRANT_NOT_PENDING:${grant.status}`,
    };
  }

  if (
    grant.type !== AccessGrantType.GUEST ||
    grant.method !== AccessMethod.PASSCODE_TIMEBOUND
  ) {
    throw new Error(
      `UNSUPPORTED_ACCESS_GRANT:${grant.type}:${grant.method}`
    );
  }

  if (!grant.reservation) {
    throw new Error("GUEST_ACCESS_RESERVATION_MISSING");
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("GUEST_ACCESS_TTLOCK_LOCK_MISSING");
  }

  await assertGuestAccessReady(
  prisma,
  grant.reservation.id
);

  if (grant.ttlockKeyboardPwdId) {
    throw new Error(
      "GUEST_PASSCODE_ID_ALREADY_EXISTS_REQUIRES_RECONCILIATION"
    );
  }

  const startDate = grant.startsAt.getTime();
  const endDate = grant.endsAt.getTime();

  if (
    !Number.isFinite(startDate) ||
    !Number.isFinite(endDate) ||
    endDate <= startDate
  ) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError: "INVALID_GUEST_PASSCODE_WINDOW",
      },
    });

    return {
      ok: false,
      reason: "INVALID_GUEST_PASSCODE_WINDOW",
    };
  }

assertAccessCodeEncryptionConfigured();

  const accessToken = await resolveGrantAccessToken(
    grant.lock.propertyId
  );

  const passcodeName = grant.reservation.reservationNumber
    ? `PinGo ${grant.reservation.reservationNumber}`.slice(0, 30)
    : "PinGo Guest";

  const demo = isInternalDemo(grant.reservation);
  if (demo && (grant.lock.ttlockLockId !== 29944630 || grant.lock.propertyId !== grant.reservation.propertyId)) {
    throw new Error("DEMO_LOCK_BINDING_REQUIRED");
  }
  const payload = (grant.ttlockPayload ?? {}) as Prisma.JsonObject;
  const rearm = payload.e15 as Prisma.JsonObject | undefined;
  const pass = await provisionGuestPasscode({
    lockId: Number(grant.lock.ttlockLockId), accessToken, name: passcodeName, startDate, endDate,
    phone: grant.reservation.guestPhone, mappedGateway: Boolean(grant.lock.ttlockGatewayRecordId),
    requireGateway: demo, savedPlan: payload.customPasscodePlan,
    ...(rearm?.state === "REARMED" && typeof rearm.observedAt === "string" ? { rearmedAt: rearm.observedAt } : {}),
    savePlan: async plan => {
      const current = await prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id }, select: { ttlockPayload: true } });
      const saved = await prisma.accessGrant.updateMany({ where: { id: grant.id, status: AccessStatus.PENDING,
        ttlockKeyboardPwdId: null, startsAt: grant.startsAt, endsAt: grant.endsAt },
        data: { ttlockPayload: { ...((current.ttlockPayload ?? {}) as Prisma.JsonObject), customPasscodePlan: plan } } });
      if (saved.count !== 1) throw new Error("CUSTOM_PASSCODE_GRANT_CHANGED_REQUIRES_RECONCILIATION");
    },
    codeReserved: async code => {
      if (await prisma.accessCode.findFirst({ where: { lockId: Number(grant.lock.ttlockLockId),
        accessCodeHash: hashAccessCode(code),
        accessGrant: { status: { not: AccessStatus.REVOKED } } }, select: { id: true } })) return true;
      const pending = await prisma.accessGrant.findMany({ where: { lockId: grant.lockId, id: { not: grant.id },
        status: { in: [AccessStatus.PENDING, AccessStatus.FAILED] },
        ttlockPayload: { path: ["customPasscodePlan"], not: Prisma.DbNull } }, select: { ttlockPayload: true } });
      return pending.some(row => {
        const plan = (row.ttlockPayload as Prisma.JsonObject)?.customPasscodePlan as Prisma.JsonObject | undefined;
        return typeof plan?.codeEnc === "string" && decryptAccessCode(plan.codeEnc) === code;
      });
    },
  });

  const code = String(pass?.keyboardPwd ?? "").trim();
  const keyboardPwdId = Number(pass?.keyboardPwdId);

  if (
    !code ||
    !Number.isFinite(keyboardPwdId) ||
    keyboardPwdId <= 0
  ) {
    await prisma.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: AccessStatus.FAILED,
        lastError:
          "TTLOCK_PERIOD_PASSCODE_RESPONSE_INCOMPLETE",
      },
    });

    return {
      ok: false,
      reason:
        "TTLOCK_PERIOD_PASSCODE_RESPONSE_INCOMPLETE",
    };
  }

 const accessCodeMasked =
    maskCode(code);
  const accessCodeHash =
    hashAccessCode(code);
  const accessCodeEnc =
    encryptAccessCode(code);
  const provisionedAt =
    new Date();
  const currentPayload = (await prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id }, select: { ttlockPayload: true } })).ttlockPayload;

    try {
    await prisma.$transaction([
      prisma.accessGrant.update({
        where: {
          id: grant.id,
          status: AccessStatus.PENDING,
          ttlockKeyboardPwdId: null,
          startsAt: grant.startsAt,
          endsAt: grant.endsAt,
        },
        data: {
          status: AccessStatus.ACTIVE,
          ttlockKeyboardPwdId:
            keyboardPwdId,
          accessCodeMasked,
          lastError: null,
          desiredStartsAt:
            grant.startsAt,
          desiredEndsAt:
            grant.endsAt,
          lastAppliedAt:
            provisionedAt,
          ttlockPayload: {
            ...(currentPayload as any),
            passcode: {
              provider: "TTLOCK",
              keyboardPwdId,
              keyboardPwdType: 3,
              provisioningMethod: pass.provisioningMethod,
              ...(pass.provisioningMethod === "CUSTOM_GATEWAY" ? { codeSource: pass.codeSource } : {}),
              startsAt:
                grant.startsAt.toISOString(),
              endsAt:
                grant.endsAt.toISOString(),
              provisionedAt:
                provisionedAt.toISOString(),
            },
          },
        },
      }),

      prisma.accessCode.upsert({
        where: {
          accessGrantId: grant.id,
        },
        create: {
          accessGrantId: grant.id,
          lockId: Number(
            grant.lock.ttlockLockId
          ),
          method: "period",
          keyboardPwdId:
            String(keyboardPwdId),
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone:
            grant.reservation.guestPhone ??
            null,
          accessCodeEnc,
          accessCodeHash,
          accessCodeMasked,
          expiresAt: grant.endsAt,
        },
        update: {
          lockId: Number(
            grant.lock.ttlockLockId
          ),
          method: "period",
          keyboardPwdId:
            String(keyboardPwdId),
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone:
            grant.reservation.guestPhone ??
            null,
          accessCodeEnc,
          accessCodeHash,
          accessCodeMasked,
          expiresAt: grant.endsAt,
        },
      }),
    ]);
  } catch (persistenceError) {
    // The confirmed custom candidate is durable. Reconcile/adopt that same PIN
    // on retry instead of deleting it and possibly creating another credential.
    if (pass.provisioningMethod === "CUSTOM_GATEWAY") throw persistenceError;
    try {
      await ttlockDeletePasscode({
        lockId: Number(
          grant.lock.ttlockLockId
        ),
        keyboardPwdId,
        deleteType: Number(
          process.env.TTLOCK_DELETE_TYPE ?? 2
        ) as 1 | 2 | 3,
        accessToken,
      });
    } catch (cleanupError) {
      console.error(
        "[GUEST_ACCESS][ORPHAN_PASSCODE_CLEANUP_FAILED]",
        {
          grantId: grant.id,
          keyboardPwdId,
          persistenceError:
            persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError),
          cleanupError:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        }
      );
    }

    throw persistenceError;
  }
  return {
    ok: true,
    passcodePlain: code,
    keyboardPwdId,
    keyboardPwdType: 3 as const,
  };
}

export async function deactivateGrant(grantId: string) {
  const grant = await prisma.accessGrant.findUnique({
    where: { id: grantId },
    include: {
      lock: true,
    },
  });

  if (!grant) {
    throw new Error("ACCESS_GRANT_NOT_FOUND");
  }

  if (grant.status !== AccessStatus.ACTIVE) {
    return {
      skipped: true,
      reason: `GRANT_NOT_ACTIVE:${grant.status}`,
    };
  }

  if (!grant.lock?.ttlockLockId) {
    throw new Error("GUEST_ACCESS_TTLOCK_LOCK_MISSING");
  }

  if (
    grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
    grant.ttlockKeyboardPwdId
  ) {
    const accessToken = await resolveGrantAccessToken(
      grant.lock.propertyId
    );

    await ttlockDeletePasscode({
      lockId: Number(grant.lock.ttlockLockId),
      keyboardPwdId: Number(grant.ttlockKeyboardPwdId),
      deleteType: Number(
        process.env.TTLOCK_DELETE_TYPE ?? 2
      ) as 1 | 2 | 3,
      accessToken,
    });
  }

  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: {
      status: AccessStatus.REVOKED,
      lastError: null,
      ttlockPayload: {
        ...(grant.ttlockPayload as any),
        revokedAt: new Date().toISOString(),
      },
    },
  });

  return { ok: true };
}
