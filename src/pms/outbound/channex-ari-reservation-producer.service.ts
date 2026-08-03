import type { Prisma } from "@prisma/client";

import {
  buildChannexAriReservationIntent,
  type ChannexAriReservationAvailabilitySnapshot,
} from "./channex-ari-reservation-intent.policy";
import { createChannexAriOutboxEvent } from "./channex-ari-outbox.service";

type ChannexAriReservationProducerDb = Pick<
  Prisma.TransactionClient,
  "distributionOutboxEvent"
>;

export type PersistChannexAriReservationIntentInput = {
  db: ChannexAriReservationProducerDb;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  previous?: ChannexAriReservationAvailabilitySnapshot | null;
  current: ChannexAriReservationAvailabilitySnapshot;
  propertyTimezone: string;
  todayDateKey: string;
  now?: Date;
  coalesceMs?: number;
};

export async function persistChannexAriReservationIntent(
  input: PersistChannexAriReservationIntentInput
) {
  const intent = buildChannexAriReservationIntent({
    previous: input.previous,
    current: input.current,
    propertyTimezone: input.propertyTimezone,
    todayDateKey: input.todayDateKey,
  });

  if (!intent) {
    return null;
  }

  return createChannexAriOutboxEvent(input.db, {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    messageKind: intent.messageKind,
    trigger: intent.trigger,
    dateKeys: intent.dateKeys,
    sourceEntityType: "RESERVATION",
    sourceEntityId: input.reservationId,
    now: input.now,
    coalesceMs: input.coalesceMs,
  });
}
