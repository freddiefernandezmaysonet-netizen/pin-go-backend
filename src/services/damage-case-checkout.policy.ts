/** checkOut is the persisted UTC instant, already derived from property local time.
 * Always use the current reservation value, never a case/email snapshot.
 * This gate authorizes no financial operation.
 */
export function isDamageCaseAfterCheckout(checkOut: unknown, now = new Date()): boolean {
  return checkOut instanceof Date &&
    Number.isFinite(checkOut.getTime()) &&
    Number.isFinite(now.getTime()) &&
    now.getTime() > checkOut.getTime();
}
