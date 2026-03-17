// src/services/ttlock/ttlock.org-auth.ts

/**
 * ============================================================================
 * Pin&Go — TTLock Organization Auth Helper
 * ============================================================================
 *
 * 🎯 RESPONSABILIDAD
 * Este archivo es la fuente única de verdad para obtener un accessToken de TTLock
 * basado en organizationId.
 *
 * 🔒 PRODUCCIÓN
 * En producción NO se deben usar:
 *  - TTLOCK_USERNAME
 *  - TTLOCK_PASSWORD_PLAIN
 *
 * Cada organización tendrá su propio:
 *  - accessToken
 *  - refreshToken
 * almacenado en la tabla TTLockAuth.
 *
 * ⚠️ MIGRACIÓN (IMPORTANTE)
 * Este archivo NO está conectado todavía al sistema principal.
 *
 * Pasos para migrar:
 *
 * 1. nfc.sync.routes.ts
 * 2. ttlock.brain.ts
 * 3. reservation.worker.ts
 * 4. eliminar dependencia de .env (username/password)
 *
 * Mientras tanto, el sistema sigue funcionando con .env (modo seguro).
 *
 * ============================================================================
 */

import { PrismaClient } from "@prisma/client";
import { ttlockRefreshAccessToken } from "../../ttlock/ttlock.service";

/**
 * Obtiene un accessToken válido de TTLock para una organización.
 *
 * - Usa el token existente si aún es válido
 * - Si expiró, usa refreshToken
 * - Guarda el nuevo token en DB
 */
export async function getOrgTtlockAccessToken(
  prisma: PrismaClient,
  organizationId: string
): Promise<string> {
  if (!organizationId) {
    throw new Error("TTLockAuth: Missing organizationId");
  }

  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId },
    select: {
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      uid: true,
    },
  });

  /**
   * --------------------------------------------------------------------------
   * ⚠️ FALLBACK TEMPORAL (DEV MODE)
   * --------------------------------------------------------------------------
   * Si no hay TTLockAuth configurado, usamos credenciales de .env.
   * Esto es SOLO para desarrollo.
   *
   * 🚫 EN PRODUCCIÓN ESTO DEBE ELIMINARSE
   */
  if (!auth) {
    if (
      process.env.TTLOCK_USERNAME &&
      process.env.TTLOCK_PASSWORD_PLAIN
    ) {
      console.warn(
        "[TTLOCK] Using ENV fallback auth (DEV ONLY)"
      );

      const { ttlockGetAccessToken } = await import(
        "../../ttlock/ttlock.service"
      );

      const token = await ttlockGetAccessToken();

      return token.access_token;
    }

    throw new Error(
      "TTLockAuth not configured for this organization"
    );
  }

  const now = Date.now();
  const expiresAtMs = auth.expiresAt
    ? new Date(auth.expiresAt).getTime()
    : 0;

  /**
   * Consideramos válido si le quedan al menos 5 minutos
   */
  const stillValid =
    !!auth.accessToken &&
    !!auth.expiresAt &&
    expiresAtMs > now + 5 * 60 * 1000;

  if (stillValid) {
    return auth.accessToken;
  }

  /**
   * --------------------------------------------------------------------------
   * 🔄 REFRESH TOKEN
   * --------------------------------------------------------------------------
   */
  if (!auth.refreshToken) {
    throw new Error(
      "TTLockAuth refreshToken missing for this organization"
    );
  }

  const refreshed = await ttlockRefreshAccessToken({
    refreshToken: auth.refreshToken,
  });

  await prisma.tTLockAuth.update({
    where: { organizationId },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? auth.refreshToken,
      uid: refreshed.uid ?? auth.uid ?? null,
      expiresAt: new Date(
        Date.now() + Number(refreshed.expires_in ?? 0) * 1000
      ),
    },
  });

  return refreshed.access_token;
}

/**
 * Helper para obtener token directamente desde propertyId
 *
 * Evita tener que resolver organizationId en múltiples capas.
 */
export async function getPropertyTtlockAccessToken(
  prisma: PrismaClient,
  propertyId: string
): Promise<string> {
  if (!propertyId) {
    throw new Error("TTLockAuth: Missing propertyId");
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true },
  });

  if (!property?.organizationId) {
    throw new Error("Property organizationId not found");
  }

  return getOrgTtlockAccessToken(prisma, property.organizationId);
}

/**
 * ============================================================================
 * 📌 USO FUTURO (EJEMPLOS)
 * ============================================================================
 *
 * ❌ ANTES (incorrecto en producción):
 *
 *   const token = await ttlockGetAccessToken();
 *
 * ✅ DESPUÉS (correcto):
 *
 *   const token = await getOrgTtlockAccessToken(prisma, organizationId);
 *
 * o:
 *
 *   const token = await getPropertyTtlockAccessToken(prisma, propertyId);
 *
 * ============================================================================
 */