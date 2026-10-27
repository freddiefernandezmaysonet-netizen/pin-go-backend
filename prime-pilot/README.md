# Pin&Go Prime — private search pilot

Isolated member dashboard with real Pin AI criteria extraction, editable filters, and live Demo calendar/price checks. It is **not commercial membership or permanent guest identity**. The prototype member is Freddie, authenticated by a private invitation exchanged for a signed, HttpOnly, SameSite session.

## Boundaries

- The only eligible property is the explicit Demo ID in `search.ts`, and it must still be ACTIVE and `isTestProperty=true`. Public listings are never automatically enrolled in Prime.
- The standalone server imports the existing availability and Direct Booking price services; it never imports the main API, workers, messaging, checkout, or TTLock clients.
- Every database connection uses `default_transaction_read_only=on`. Startup verifies that setting before opening HTTP. No migrations, reservations, membership rows, access grants, or payments are written.
- A result is a test quote, not held inventory. Commercial checkout, authenticated long-lived member accounts, host enrollment, discounts, and automatic NFC activation remain future work.
- Child/infant permission and unknown capacity fail closed. Supported features must come from structured listing evidence or exact amenity names; optional paid amenities are not inferred as included.
- OpenAI only extracts typed criteria. The server validates them, selects the allowlisted catalog, and computes results. No arbitrary tools, property IDs, URLs, SQL, or free-text promises are accepted from the model.
- Criteria can be searched without AI through the editable filters. Relative dates use Puerto Rico's date; max stay is 60 nights. Only USD total budgets are supported.
- NFC status records the completed physical Demo test. It does not assert current gateway health or active member access.

## Runtime and secret handling

Deploy only this folder's Dockerfile as a dedicated service. Entry point: `node --import tsx prime-pilot/server.ts`; healthcheck `/health`. Do not deploy `src/server.ts` for the pilot. Root backend package/schema remain unchanged.

The new `PRIME_OPENAI_API_KEY` belongs to the dedicated **PinGo Prime — Pruebas** OpenAI project. It does not reuse production `OPENAI_API_KEY` or a production saved agent. Model: `gpt-5.4-mini`, Responses API, structured output, `store:false`.

Configuration is on the new pilot's private volume `/prime-data`, mode 0600. One-use provisioning accepts a direct HTTPS request from the local helper only when its bootstrap bearer matches the configured SHA-256 digest. After setup, that endpoint returns 404; remove `PRIME_BOOTSTRAP_SHA256` or set it empty after setup. The invitation hash and random session signing key are saved with the API key; the raw invitation is not stored remotely. Access expires after 30 days; sessions after seven days. Daily AI allowance is 100 requests and is persisted across restarts. The app logs neither queries nor secrets.

Required service variables: `DATABASE_URL` (reference to the existing database), `NODE_ENV=production`, `PRIME_DATA_DIR=/prime-data`; temporary `PRIME_BOOTSTRAP_SHA256` only for initial setup. The persistent volume is isolated to this service. No production credentials are copied into source or published artifacts.

Local key file `.env.prime.local` and one-use `.env.prime-provision.json` are Git-ignored. Run `PRIME_PILOT_URL=https://<the-created-service>.up.railway.app node --env-file=.env.prime.local prime-pilot/provision.mjs`. The helper prints only status. Never run it against an unverified destination. Do not regenerate keys on a setup retry.

## Validation

```
node --import tsx --test prime-pilot/search.test.ts prime-pilot/app.test.ts
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop prime-pilot/search.ts prime-pilot/catalog.ts prime-pilot/app.ts prime-pilot/server.ts
npm ci --prefix prime-pilot
npm run typecheck --prefix prime-pilot
npm run build --prefix prime-pilot
```

Behavior tests cover allowlist enforcement, unavailable inventory, real total budget calculation, children/capacity/NFC/preferences, invalid dates and upstream failures. HTTP tests exercise one-use setup, unauthenticated reads, forged sessions, cross-origin requests, persistent quota, cookie protections, and sign-out. Browser checks should cover desktop/mobile overflow, invitation login, missing criteria, results, editable filters, empty/error states, details dialog, Spanish/English, navigation, and sign-out. Use explicitly marked synthetic fixtures only for local UI tests; live API checks use the Demo property.

Optional `PRIME_READONLY_CANARY=1` runs one fixed Demo search for November 6–9, 2026 (two adults) on startup after verifying read-only database mode. It logs only the test quote and result count, never guest/booking/conflict data. Disable after evidence collection.

Disable the pilot by stopping its dedicated service. Production routes and workers are unchanged.
