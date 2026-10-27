# Prime pilot verification — October 27, 2026

## Passed

- TypeScript: strict check of the pilot API, catalogue adapter, and React client.
- Vite production build: passed; client bundle about 70 kB gzip, no credential values in client source.
- Seven search/HTTP tests: passed. Catalogue isolation; unavailable dates; full-price budget; invalid dates; occupancy, child/infant and feature checks; upstream failures; one-use provisioning; unsigned/forged session rejection; same-origin policy; daily AI quota; signed HttpOnly cookie and logout.
- One React DOM interaction test: passed with clearly isolated fixtures. Explore/Card/Trips navigation, Spanish/English, example search, criteria update, empty results and sign-out. This is not a browser layout or real-device certification.
- Two real OpenAI calls using the new isolated Prime key: successful. Initial request extracted Puerto Rico, November 6–9, two adults, total USD 500. Follow-up changed to November 13–16 and added private pool + NFC while retaining the other criteria.
- Railway startup verified PostgreSQL `default_transaction_read_only=on` before listening.
- Live read-only search against Demo, November 6–9, two adults: one available result, zero failures. The canonical pricing service returned USD 6.69 total (the existing Demo test tariff); this is not a commercial offer. No data was written.

## Live activation, October 27

- The founder explicitly authorized the HTTPS domain and separately authorized transfer/storage of the dedicated `PRIME_OPENAI_API_KEY` in `prime-dashboard-pilot`.
- HTTPS is active at https://prime-dashboard-pilot-production.up.railway.app/. One-use provisioning completed with HTTP 200; its endpoint subsequently returns 404. The key is held only in the pilot's private configuration volume and the ignored local file, never in browser bundles or Git.
- Live HTTPS integration: invitation exchanged for a Secure, HttpOnly, SameSite session; unauthenticated member request rejected with 401; cross-origin search rejected with 403.
- Authenticated natural-language search reached OpenAI, then the canonical Demo availability/pricing services and returned one result (USD 6.69 test tariff). A total budget of USD 5 correctly produced NO_MATCHES.
- The browser visibly rendered the private invitation screen. A personal PDF invitation with a button to the founder's authenticated entry link was delivered privately; that link is intentionally absent from this repository.
- The optional reset of the bootstrap environment digest was rejected by approval review and not applied. The persisted configuration already disables provisioning, verified with HTTP 404; existing protection was preserved.

## Pending

- Authenticated browser visual review, mobile visual review, and the founder's first manual test. The automated React interaction test is not real-device certification.
- Prime permanent accounts, host opt-in, commercial benefits/prices, booking checkout, member trip linkage, and automatic NFC reservation grants are not part of this pilot.

Production `OPENAI_API_KEY`, public booking settings, production API routes, workers, existing reservations, payments, and access grants were not changed.
