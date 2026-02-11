// src/utils/dates.ts
export function asDate(value: unknown, fieldName: string): Date {
  if (typeof value !== 'string') throw new Error(`${fieldName} must be an ISO string`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${fieldName} must be a valid ISO date string`);
  return d;
}

export function assertCheckInOut(checkIn: Date, checkOut: Date) {
  if (!(checkIn instanceof Date) || !(checkOut instanceof Date)) throw new Error('Invalid dates');
  if (checkOut <= checkIn) throw new Error('checkOut must be after checkIn');
}
