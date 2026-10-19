import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { decryptMobileAccessSecret } from '../guest-mobile/mobile-access-crypto.service.js';

// Read-only incident audit. Never register/reset a user, issue keys, or update DB.
const reservationNumber = process.argv[2];
if (!/^PG-\d{4}-\d{6}$/.test(reservationNumber ?? '')) {
  throw new Error('Usage: node --import tsx src/scripts/audit-guest-ttlock-recipient.ts PG-YYYY-NNNNNN');
}
const prisma = new PrismaClient();
try {
  const reservation = await prisma.reservation.findUnique({ where: { reservationNumber }, select: { id: true, propertyId: true, checkIn: true, checkOut: true } });
  if (!reservation) throw new Error('RESERVATION_NOT_FOUND');
  const stay = await prisma.guestStayLink.findUnique({ where: { reservationId: reservation.id }, select: { guestPersonId: true } });
  if (!stay) throw new Error('GUEST_STAY_LINK_NOT_FOUND');
  const identity = await prisma.tTLockRecipientIdentity.findUnique({ where: { guestPersonId: stay.guestPersonId } });
  if (!identity) throw new Error('RECIPIENT_IDENTITY_NOT_FOUND');
  let passwordFormat = 'unavailable';
  if (identity.passwordCiphertext && identity.passwordKeyVersion) {
    for (const [format, aad] of [
      ['persisted-provider', `mobile-access:ttlock-recipient:v1:${identity.id}:password`],
      ['legacy-bootstrap', `mobile-access:ttlock-recipient:v1:pending:${identity.guestPersonId}:bootstrap`],
    ]) {
      try { decryptMobileAccessSecret(identity.passwordCiphertext, identity.passwordKeyVersion, aad); passwordFormat = format; break; } catch { /* report format only */ }
    }
  }
  const credentialCounts = await prisma.mobileAccessCredential.groupBy({ by: ['status'], where: { guestPersonId: identity.guestPersonId }, _count: true });
  console.log(JSON.stringify({ reservationNumber, propertyId: reservation.propertyId, checkIn: reservation.checkIn, checkOut: reservation.checkOut,
    identityId: identity.id, username: identity.username, status: identity.status, createdAt: identity.createdAt, registeredAt: identity.registeredAt,
    passwordFormat, hasAccessToken: !!identity.accessTokenCiphertext, hasRefreshToken: !!identity.refreshTokenCiphertext, credentialCounts }, null, 2));
  const clientId = process.env.TTLOCK_CLIENT_ID?.trim();
  const clientSecret = process.env.TTLOCK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('TTLOCK_CLIENT_CREDENTIALS_MISSING');
  // Narrow registration window around this identity, with bounded pagination.
  const startDate = identity.createdAt.getTime() - 60_000;
  const endDate = identity.createdAt.getTime() + 30 * 60_000;
  const registrations: { userid: string; regtime: number }[] = [];
  let complete = false;
  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    const response = await axios.get(`${process.env.TTLOCK_API_BASE ?? 'https://api.sciener.com'}/v3/user/list`, {
      params: { clientId, clientSecret, startDate, endDate, pageNo, pageSize: 100, date: Date.now() }, timeout: 15000,
    });
    const data = response.data;
    if ((data?.errcode != null && Number(data.errcode) !== 0) || !Array.isArray(data?.list) || !Number.isInteger(data.pages) || data.pages < 0) throw new Error('TTLOCK_USER_LIST_INVALID');
    for (const entry of data.list) {
      if (typeof entry.userid !== 'string' || !Number.isFinite(Number(entry.regtime))) throw new Error('TTLOCK_USER_LIST_INVALID');
      const regtime = Number(entry.regtime);
      if (regtime >= startDate && regtime <= endDate) registrations.push({ userid: entry.userid, regtime });
    }
    if (pageNo >= data.pages) { complete = true; break; }
  }
  console.log(JSON.stringify({ readOnly: true, complete, registrationWindow: { startDate, endDate }, registrations,
    note: 'Candidates are evidence only. No automatic username matching or password reset.' }, null, 2));
} catch {
  // Axios/Prisma errors may contain request secrets or connection strings.
  console.error('GUEST_TTLOCK_AUDIT_FAILED: inspect the sanitized report above; no credentials were printed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
