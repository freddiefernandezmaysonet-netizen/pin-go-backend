import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { criteriaSchema, emptyCriteria, historySchema, interpret, composeReply, fallbackReply, eligible, searchCatalog, validateStay, type ConversationFacts } from './search.js';
import { hasTripDetails, savedTripStore, tripIdSchema, tripInputSchema } from './saved-trips.js';
import { enrollmentInputSchema, enrollmentStore } from './enrollment.js';

export function createPilotApp(options: { dataDir: string; bootstrapHash?: string; production: boolean; catalog: Parameters<typeof searchCatalog>[1]; interpret?: typeof interpret; composeReply?: typeof composeReply }) {
const { dataDir, catalog } = options;
const interpretCriteria = options.interpret || interpret;
const replyToTraveler = options.composeReply || composeReply;
const configPath = resolve(dataDir, 'config.json');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configSchema = z.object({ PRIME_OPENAI_API_KEY: z.string().min(40).max(500), invitationHash: z.string().length(64), sessionSecret: z.string().length(64), expiresAt: z.number() });
type Config = z.infer<typeof configSchema>;
let config: Config | null = existsSync(configPath) ? configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))) : null;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); next(); });
app.use(express.json({ limit: '96kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, configured: !!config, pilot: true }));
// One-use provisioning: the bootstrap bearer is transferred directly over HTTPS by the local helper.
// The OpenAI key never appears in source, URLs, logs, connector arguments, or browser storage.
app.post('/internal/provision', (req, res) => {
  if (config || !options.bootstrapHash) return void res.sendStatus(404);
  const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!equal(hash(bearer), options.bootstrapHash)) return void res.sendStatus(404);
  const parsed = z.object({ apiKey: z.string().min(40).max(500), invitation: z.string().min(40).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) return void res.sendStatus(400);
  const next = { PRIME_OPENAI_API_KEY: parsed.data.apiKey, invitationHash: hash(parsed.data.invitation), sessionSecret: randomBytes(32).toString('hex'), expiresAt: Date.now() + 30 * 86400000 };
  writeFileSync(configPath, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
  config = next;
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin !== `${options.production ? 'https' : req.protocol}://${req.get('host')}`) return void res.status(403).json({ error: 'ORIGIN_REQUIRED' });
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
  res.cookie('prime_session', payload + '.' + signature, { httpOnly: true, secure: options.production, sameSite: 'strict', path: '/api', maxAge: 7 * 86400000 });
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('prime_session='))?.slice('prime_session='.length) || '';
  const [payload, signature] = token.split('.');
  try {
    const expected = createHmac('sha256', config!.sessionSecret).update(payload).digest('base64url');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!signature || !equal(signature, expected) || parsed.member !== 'prime-pilot-founder' || !(parsed.exp > Date.now())) throw new Error();
    res.locals.primePrincipal = parsed.member;
  } catch { return void res.status(401).json({ error: 'SESSION_REQUIRED' }); }
  next();
});
app.delete('/api/session', (_req, res) => { res.clearCookie('prime_session', { path: '/api' }); res.json({ ok: true }); });
app.get('/api/member', (_req, res) => res.json({ name: 'Freddie', status: 'PILOT', capabilities: ['PILOT_HOST_SETUP'], expiresAt: config!.expiresAt, cardStatus: 'NFC_PILOT_VERIFIED', activeAccesses: 0, trips: [] }));
const enrollment = enrollmentStore(dataDir);
app.use('/api/pilot/enrollment', (_req, res, next) => {
  if (res.locals.primePrincipal !== 'prime-pilot-founder') return void res.status(403).json({ error: 'PILOT_FOUNDER_REQUIRED' });
  next();
});
app.get('/api/pilot/enrollment', (_req, res) => {
  try { res.json({ enrollment: enrollment.read() }); }
  catch { res.status(503).json({ error: 'ENROLLMENT_UNAVAILABLE' }); }
});
app.put('/api/pilot/enrollment', (req, res) => {
  const parsed = enrollmentInputSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'INVALID_ENROLLMENT' });
  try {
    const result = enrollment.save(parsed.data);
    if (result.error) return void res.status(409).json({ error: result.error });
    res.json(result);
  } catch { res.status(503).json({ error: 'ENROLLMENT_UNAVAILABLE' }); }
});
const plans = savedTripStore(dataDir);
app.get('/api/saved-trips', (_req, res) => {
  try { res.json({ trips: plans.list() }); }
  catch { res.status(503).json({ error: 'SAVED_TRIPS_UNAVAILABLE' }); }
});
function saveTrip(req: express.Request, res: express.Response) {
  const parsed = tripInputSchema.safeParse(req.body);
  const id = req.params.tripId;
  if (!parsed.success || (id && !tripIdSchema.safeParse(id).success)) return void res.status(400).json({ error: 'INVALID_TRIP' });
  if (!hasTripDetails(parsed.data.criteria)) return void res.status(400).json({ error: 'EMPTY_TRIP' });
  try {
    const result = plans.save(parsed.data, id);
    if (result.error) return void res.status(result.error === 'TRIP_NOT_FOUND' ? 404 : 409).json({ error: result.error });
    res.status(result.created ? 201 : 200).json({ trip: result.trip });
  } catch { res.status(503).json({ error: 'SAVED_TRIPS_UNAVAILABLE' }); }
}
app.post('/api/saved-trips', saveTrip);
app.put('/api/saved-trips/:tripId', saveTrip);
app.delete('/api/saved-trips/:tripId', (req, res) => {
  if (!tripIdSchema.safeParse(req.params.tripId).success) return void res.status(400).json({ error: 'INVALID_TRIP' });
  try {
    if (!plans.remove(req.params.tripId)) return void res.status(404).json({ error: 'TRIP_NOT_FOUND' });
    res.json({ ok: true });
  } catch { res.status(503).json({ error: 'SAVED_TRIPS_UNAVAILABLE' }); }
});
const requestSchema = z.object({ message: z.string().trim().min(1).max(1600).optional(), criteria: criteriaSchema.default(emptyCriteria), history: historySchema.default([]), language: z.enum(['es', 'en']).default('es') }).strict();
let busy = false;
app.post('/api/search', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'INVALID_SEARCH' });
  if (busy) return void res.status(429).json({ error: 'SEARCH_IN_PROGRESS' });
  busy = true;
  try {
    let { criteria } = parsed.data;
    const { message, history, language } = parsed.data;
    let clarification: string | null = null;
    let intent: 'search' | 'question' | 'chat' = 'search';
    if (message) {
      const usagePath = resolve(dataDir, 'usage.json');
      const usage = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) : {};
      const count = usage.day === today() ? Number(usage.count) : 0;
      if (!Number.isFinite(count) || count >= 100) return void res.status(429).json({ error: 'PILOT_DAILY_LIMIT' });
      writeFileSync(usagePath + '.tmp', JSON.stringify({ day: today(), count: count + 1 }), { mode: 0o600 });
      renameSync(usagePath + '.tmp', usagePath);
      ({ criteria, clarification, intent } = await interpretCriteria(message, criteria, config!.PRIME_OPENAI_API_KEY, language, today(), history));
    }
    const missing = validateStay(criteria, today());
    const paused = enrollment.read().participation === 'PAUSED';
    let properties = paused ? [] : (await catalog.catalog()).filter(eligible);
    let facts: ConversationFacts = { criteria, clarification, missing, results: [], failed: 0, status: intent === 'chat' ? 'CHAT' : intent === 'question' ? 'QUESTION' : 'NEEDS_DETAILS' };
    if (intent === 'search' && paused) facts.status = 'CATALOG_PAUSED';
    else if (intent === 'search' && !missing.length && !clarification) {
      const found = await searchCatalog(criteria, { ...catalog, catalog: async () => properties });
      facts = { ...facts, ...found, status: found.failed ? 'PARTIAL_ERROR' : found.results.length ? 'RESULTS' : 'NO_MATCHES' };
    }
    if (enrollment.read().participation === 'PAUSED') {
      properties = [];
      if (intent === 'search') facts = { ...facts, status: 'CATALOG_PAUSED', results: [], failed: 0, diagnostics: undefined };
    }
    let reply = fallbackReply(facts, language);
    let replyFallback = false;
    if (message && facts.status !== 'CATALOG_PAUSED') {
      try { reply = await replyToTraveler(message, history, facts, properties, config!.PRIME_OPENAI_API_KEY, language); }
      catch { replyFallback = true; } // A narration failure must not discard a verified quote.
    }
    // A pause during an in-flight provider call must also invalidate its result and narration.
    if (intent === 'search' && enrollment.read().participation === 'PAUSED') {
      facts = { ...facts, status: 'CATALOG_PAUSED', results: [], failed: 0, diagnostics: undefined };
      reply = fallbackReply(facts, language);
    }
    res.json({ ...facts, reply, replyFallback });
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
return app;
}
