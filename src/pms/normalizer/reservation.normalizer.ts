import {
  NormalizedReservation,
  ReservationNormalizerContext,
  ReservationNormalizerFn,
  PmsProviderKey,
} from "./reservation.normalizer.types";

/**
 * Registro interno de normalizers por proveedor.
 */
const normalizers: Partial<Record<PmsProviderKey, ReservationNormalizerFn>> = {};

/**
 * Permite registrar un normalizer de proveedor.
 * Cada PMS llamará a esto al inicializar su módulo.
 */
export function registerReservationNormalizer(
  provider: PmsProviderKey,
  fn: ReservationNormalizerFn
) {
  normalizers[provider] = fn;
}

/**
 * Ejecuta el normalizer correspondiente al proveedor.
 */
export async function normalizeReservationEvent(
  ctx: ReservationNormalizerContext
): Promise<NormalizedReservation> {
  const provider = ctx.provider;

  const normalizer = normalizers[provider];

  if (!normalizer) {
    throw new Error(`NO_NORMALIZER_REGISTERED_FOR_PROVIDER_${provider}`);
  }

  const result = await normalizer(ctx);

  validateNormalizedReservation(result);

  return result;
}

/**
 * Validación mínima del resultado.
 * Evita que un adaptador PMS rompa el sistema.
 */
function validateNormalizedReservation(
  r: NormalizedReservation
) {
  if (!r.externalReservationId) {
    throw new Error("NORMALIZED_RESERVATION_MISSING_EXTERNAL_ID");
  }

  if (!r.checkIn) {
    throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKIN");
  }

  if (!r.checkOut) {
    throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKOUT");
  }

  if (!r.status) {
    throw new Error("NORMALIZED_RESERVATION_MISSING_STATUS");
  }
}