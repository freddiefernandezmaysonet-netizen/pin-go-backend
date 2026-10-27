import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { criteriaSchema, emptyCriteria, interpret, searchCatalog, validateStay } from './search.js';

const dataDir = process.env.PRIME_DATA_DIR || '/prime-data';
const configPath = resolve(dataDir, 'config.json');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configSchema = z.object({ PRIME_OPENAI_API_KEY: z.string().min(40).max(500), invitationHash: z.string().length(64), sessionSecret: z.string().length(64), expiresAt: z.number() });
type Config = z.infer<typeof configSchema>;
let config: Config | null = existsSync(configPath) ? configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))) : null;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dbUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/prime_unconfigured');
dbUrl.searchParams.set('options', '-c default_transaction_read_only=on');
process.env.DATABASE_URL = dbUrl.toString();
const db = new PrismaClient();
const [{ default_transaction_read_only: readOnly }] = await db.$queryRawUnsafe<Array<{ default_transaction_read_only: string }>>('SHOW default_transaction_read_only');
if (readOnly !== 'on') throw new Error('PRIME_DATABASE_MUST_BE_READ_ONLY');
await db.$disconnect();
const catalog = await import('./catalog.js');
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); next(); });
app.use(express.json({ limit: '12kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, configured: !!config, pilot: true }));
// One-use provisioning: the bootstrap bearer is transferred directly over HTTPS by the local helper.
// The OpenAI key never appears in source, URLs, logs, connector arguments, or browser storage.
app.post('/internal/provision', (req, res) => {
  if (config || !process.env.PRIME_BOOTSTRAP_SHA256) return void res.sendStatus(404);
  const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!equal(hash(bearer), process.env.PRIME_BOOTSTRAP_SHA256)) return void res.sendStatus(404);
  const parsed = z.object({ apiKey: z.string().min(40).max(500), invitation: z.string().min(40).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) return void res.sendStatus(400);
  const next = { PRIME_OPENAI_API_KEY: parsed.data.apiKey, invitationHash: hash(parsed.data.invitation), sessionSecret: randomBytes(32).toString('hex'), expiresAt: Date.now() + 30 * 86400000 };
  writeFileSync(configPath, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
  config = next;
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin !== `${process.env.NODE_ENV === 'production' ? 'https' : req.protocol}://${req.get('host')}`) return void res.status(403).json({ error: 'ORIGIN_REQUIRED' });
  if (!config || config.expiresAt < Date.now()) return void res.status(503).json({ error: 'PILOT_UNAVAILABLE' });
  next();
});
let loginAttempts = { window: 0, count: 0 };
app.post('/api/session', (req, res) => {
  if (Date.now() - loginAttempts.window > 60000) loginAttempts = { window: Date.now(), count: 0 };
  if (++loginAttempts.count > 20) return void res.status(429).json({ error: 'TRY_LATER' });
  if (typeof req.body?.invitation !== 'string' || !equal(hash(req.body.invitation), config!.invitationHash)) return void res.status(401).json({ error: 'INVITATION_REQUIRED' });
  const payload = Buffer.from(JSON.stringify({ member: 'prime-pilot-founder', exp: Math.min(Date.now() + 7 * 86400000, config!.expiresAt) })).toString('base64url');
  const signature = createHmac('sha256', config!.sessionSecret).update(payload).digest('base64url');
  res.cookie('prime_session', payload + '.' + signature, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api', maxAge: 7 * 86400000 });
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('prime_session='))?.slice('prime_session='.length) || '';
  const [payload, signature] = token.split('.');
  try {
    const expected = createHmac('sha256', config!.sessionSecret).update(payload).digest('base64url');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!signature || !equal(signature, expected) || parsed.member !== 'prime-pilot-founder' || !(parsed.exp > Date.now())) throw new Error();
  } catch { return void res.status(401).json({ error: 'SESSION_REQUIRED' }); }
  next();
});
app.delete('/api/session', (_req, res) => { res.clearCookie('prime_session', { path: '/api' }); res.json({ ok: true }); });
app.get('/api/member', (_req, res) => res.json({ name: 'Freddie', status: 'PILOT', expiresAt: config!.expiresAt, cardStatus: 'NFC_PILOT_VERIFIED', activeAccesses: 0, trips: [] }));
const requestSchema = z.object({ message: z.string().trim().min(1).max(1600).optional(), criteria: criteriaSchema.default(emptyCriteria), language: z.enum(['es', 'en']).default('es') }).strict();
let busy = false;
app.post('/api/search', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'INVALID_SEARCH' });
  if (busy) return void res.status(429).json({ error: 'SEARCH_IN_PROGRESS' });
  busy = true;
  try {
    let { criteria } = parsed.data;
    let clarification: string | null = null;
    if (parsed.data.message) {
      const usagePath = resolve(dataDir, 'usage.json');
      const usage = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) : {};
      const count = usage.day === today() ? Number(usage.count) : 0;
      if (!Number.isFinite(count) || count >= 100) return void res.status(429).json({ error: 'PILOT_DAILY_LIMIT' });
      writeFileSync(usagePath + '.tmp', JSON.stringify({ day: today(), count: count + 1 }), { mode: 0o600 });
      renameSync(usagePath + '.tmp', usagePath);
      ({ criteria, clarification } = await interpret(parsed.data.message, criteria, config!.PRIME_OPENAI_API_KEY, parsed.data.language, today()));
    }
    const missing = validateStay(criteria, today());
    if (missing.length || clarification || criteria.unsupported.length) return void res.json({ criteria, clarification, missing, results: [], failed: 0, status: 'NEEDS_DETAILS' });
    const results = await searchCatalog(criteria, catalog);
    res.json({ criteria, clarification: null, missing: [], ...results, status: results.failed ? 'PARTIAL_ERROR' : results.results.length ? 'RESULTS' : 'NO_MATCHES' });
  } catch (error) {
    // Never log request bodies, provider payloads, reservation details, or credentials.
    console.error('[prime-pilot]', error instanceof Error && error.message === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE' : 'SEARCH_UNAVAILABLE');
    res.status(503).json({ error: 'SEARCH_UNAVAILABLE' });
  } finally { busy = false; }
});
app.use('/api', (_req, res) => res.sendStatus(404));
app.use(express.static(resolve('prime-pilot/dist'), { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(resolve('prime-pilot/dist/index.html')));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: 'INVALID_REQUEST' }); });
app.listen(Number(process.env.PORT || 4178), '0.0.0.0', () => console.info('Prime pilot ready; database read-only; no booking/access/payment handlers.'));
