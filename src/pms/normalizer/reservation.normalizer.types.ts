/**
 * Tipos base para el Reservation Normalizer Engine de Pin&Go.
 * Este contrato es el idioma universal entre cualquier PMS y el core de Pin&Go.
 */

export type PmsProviderKey =
  | "GUESTY"
  | "CLOUDBEDS"
  | "HOSTAWAY"
  | "MANUAL";

/**
 * Estados normalizados de una reserva.
 * El estado operacional (UPCOMING / IN_HOUSE / CHECKED_OUT)
 * lo calcula Pin&Go a partir de checkIn / checkOut.
 */
export type NormalizedReservationStatus =
  | "ACTIVE"
  | "CANCELLED";

/**
 * Estado de pago simplificado.
 * Cada PMS tiene sus propios estados; aquí los reducimos.
 */
export type NormalizedPaymentState =
  | "PAID"
  | "UNPAID"
  | "PARTIAL"
  | "UNKNOWN";

/**
 * Resultado normalizado de un evento de reserva
 * proveniente de cualquier PMS.
 */
export type NormalizedReservation = {
  /**
   * PMS proveedor
   */
  provider: PmsProviderKey;

  /**
   * ID de la reserva en el PMS externo
   */
  externalReservationId: string;

  /**
   * ID del listing / room / unit en el PMS externo
   */
  externalListingId: string | null;

  /**
   * Información del huésped
   */
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;

  /**
   * Fechas principales
   */
  checkIn: string;
  checkOut: string;

  /**
   * Estado de la reserva
   */
  status: NormalizedReservationStatus;

  /**
   * Estado de pago
   */
  paymentState: NormalizedPaymentState;

  /**
   * Tipo de evento del PMS
   * (created / modified / cancelled / etc)
   */
  rawEventType: string | null;

  /**
   * Timestamp de actualización del PMS
   */
  rawUpdatedAt: string | null;

  /**
   * Notas opcionales
   */
  notes?: string | null;
};

/**
 * Contexto necesario para ejecutar el normalizer.
 */
export type ReservationNormalizerContext = {
  provider: PmsProviderKey;
  eventType: string | null;
  payload: unknown;
};

/**
 * Firma de una función normalizadora por proveedor.
 */
export type ReservationNormalizerFn = (
  ctx: ReservationNormalizerContext
) => Promise<NormalizedReservation>;