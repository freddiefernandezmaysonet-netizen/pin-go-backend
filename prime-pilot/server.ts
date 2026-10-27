import { PrismaClient } from '@prisma/client';
import { createPilotApp } from './app.js';

const dbUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/prime_unconfigured');
dbUrl.searchParams.set('options', '-c default_transaction_read_only=on');
process.env.DATABASE_URL = dbUrl.toString();
const db = new PrismaClient();
const [{ default_transaction_read_only: readOnly }] = await db.$queryRawUnsafe<Array<{ default_transaction_read_only: string }>>('SHOW default_transaction_read_only');
if (readOnly !== 'on') throw new Error('PRIME_DATABASE_MUST_BE_READ_ONLY');
await db.$disconnect();
const catalog = await import('./catalog.js');
if (process.env.PRIME_READONLY_CANARY === '1') {
  const { searchCatalog, emptyCriteria } = await import('./search.js');
  const result = await searchCatalog({ ...emptyCriteria, destination: 'Puerto Rico', checkIn: '2026-11-06', checkOut: '2026-11-09', adults: 2 }, catalog);
  console.info(JSON.stringify({ kind: 'prime-readonly-canary', catalogCount: (await catalog.catalog()).length, results: result.results.map(r => ({ name: r.property.name, quote: r.quote, checkedAt: r.checkedAt })), failed: result.failed }));
}
const app = createPilotApp({ dataDir: process.env.PRIME_DATA_DIR || '/prime-data', bootstrapHash: process.env.PRIME_BOOTSTRAP_SHA256, production: process.env.NODE_ENV === 'production', catalog });
app.listen(Number(process.env.PORT || 4178), '0.0.0.0', () => console.info('Prime pilot ready; database read-only; no booking/access/payment handlers.'));
