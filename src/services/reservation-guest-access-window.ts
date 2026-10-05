/** Desired guest access follows both boundaries of the approved reservation. */
export function guestAccessWindow(
  current: { startsAt: Date; endsAt: Date },
  reservation: { checkIn: Date; checkOut: Date },
) {
  return {
    startsAt: reservation.checkIn,
    endsAt: reservation.checkOut,
    changed:
      current.startsAt.getTime() !== reservation.checkIn.getTime() ||
      current.endsAt.getTime() !== reservation.checkOut.getTime(),
  };
}

export function guestAccessNeedsSync(
  current: { startsAt: Date; endsAt: Date; lastError?: string | null },
  reservation: { checkIn: Date; checkOut: Date },
  errorPrefix: string,
) {
  return guestAccessWindow(current, reservation).changed ||
    current.lastError?.startsWith(`${errorPrefix}:`) === true;
}

/** Persist intent before I/O, but acknowledge the new window only after success.
 * A crash after provider success is safe to retry with the same desired period.
 * The caller must leave reservation reconciliation snapshots untouched on failure.
 */
export async function synchronizeGuestAccessWindow(input: {
  next: { startsAt: Date; endsAt: Date };
  errorPrefix: string;
  synchronize?: (() => Promise<unknown>) | undefined;
  persist: (data: { startsAt?: Date; endsAt?: Date; lastError: string | null }) => Promise<unknown>;
}) {
  if (input.synchronize) {
    await input.persist({ lastError: `${input.errorPrefix}: PENDING` });
    try {
      await input.synchronize();
    } catch (error) {
      // Keep the durable pending marker even if recording the failure also fails.
      await input.persist({ lastError: `${input.errorPrefix}: FAILED` }).catch(() => {});
      throw error;
    }
  }
  await input.persist({
    startsAt: input.next.startsAt,
    endsAt: input.next.endsAt,
    lastError: null,
  });
}
