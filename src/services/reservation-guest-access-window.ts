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
