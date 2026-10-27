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

- Authenticated browser visual review and mobile visual review. The founder confirmed the initial pilot test passed before this conversational update. The automated React interaction test is not real-device certification.
- Prime permanent accounts, host opt-in, commercial benefits/prices, booking checkout, member trip linkage, and automatic NFC reservation grants are not part of this pilot.

Production `OPENAI_API_KEY`, public booking settings, production API routes, workers, existing reservations, payments, and access grants were not changed.

## Conversational update — October 27

- Replaced the single search response with visible user/Pin AI turns, follow-up messages, a new-trip reset, and collapsed editable trip details. The last 12 turns provide context; current criteria survive across replies. History resets on reload and is not persisted to the server.
- Separate typed interpretation and grounded narration use the dedicated Prime model/key. Replies receive only allowlisted facts, actual search outcomes and exclusion reasons. The model never controls booking, payment or access tools. Unknown required features remain hard requirements; beach proximity is not treated as beach access.
- Nine API/search test groups and one React interaction test passed. Coverage includes bounded history, conversational follow-ups, no implicit relaxation of private-pool requirements, overlapping exclusion diagnostics, no AI calls for manual filters, and keeping a real quote when narration fails.
- API/test and client strict TypeScript checks and the Vite production build passed.
- Real model smoke test: a Puerto Rico request for two people with private pool/beach proximity retained both requirements when the next message supplied only November 6–9 dates. The generated answer requested dates and identified beach proximity as unconfirmed. This model smoke test used an empty synthetic catalog, not a live availability claim.
- Runtime commit `1ee673ea7d84c61ac5a1bae0c03f96c5b66726f6` deployed successfully to the isolated pilot (deployment `cc538a49-a8ba-4348-aa3c-cdfdc193ad84`). Startup again confirmed the database is read-only. The public client serves the new conversational bundle; unauthenticated member access still returns 401.
- Authenticated live three-turn conversation passed with generated replies (no narration fallback): (1) Puerto Rico for two adults asked only for dates; (2) a short reply with November 6–9 and USD 500 returned the Demo quote of USD 6.69, keeping the destination and guest count; (3) requiring a private pool and a five-minute walk to the beach returned NO_MATCHES and explained both features are unconfirmed, while preserving dates, party and budget.
- The Demo quote remains a test tariff, not a commercial offer. The checks used no booking, payment or access handlers. Authenticated browser visual/mobile certification remains pending; the founder can test the new experience through the same invitation.

## Listing evidence expansion — October 27

- Audit found structured bedrooms/bathrooms, beds, features/shared spaces and host-managed nearby places already in the property model. Nearby records have no structured travel mode or independent route verification.
- Pilot-only implementation reads those public fields for Demo. Supports 19 amenity/feature criteria plus minimum bedroom/full-bathroom counts. Missing counts fail closed; beds do not substitute for bedrooms and half bathrooms do not substitute for full bathrooms. Private/shared pool ambiguity is not advertised as a private pool.
- The stay dialog shows host-published features, room/bathroom/bed data, pool privacy and reported nearby places with explicit provenance and unknown travel mode. No production property enrollment or data changes.
- Fourteen API/search/evidence test groups and the React interaction test passed; strict API/client type checks and production build passed. UI test covers detail-dialog facts, shared-pool disclosure, bedroom minimum editing and the unknown transport label. This remains a DOM test, not authenticated mobile visual certification.
- A real model request correctly extracted entire lodging, two bedrooms, two full bathrooms, ocean view and workspace, preserving five-minute walking proximity as an unsupported Spanish requirement.
- Runtime commit `ca96bd150e32558290e5465d1f4af4450721e27f` deployed successfully to the isolated pilot (deployment `fc3a5535-b3ce-4d31-a136-59fd18703969`). New client asset served; unauthenticated member API remains 401; startup confirms database read-only.
- Live authenticated read returned Demo’s published facts: 1 bedroom, 1 full bathroom, pool privacy unconfirmed, no nearby places recorded, and included pool/Wi-Fi/hot tub/air conditioning/parking/pets/entire-place features. The existing canonical quote was USD 6.69 for the three-night test; older clients without the new minimum fields remain compatible.
- A live question correctly answered the bedroom/bathroom counts and said it could not confirm pool privacy or a five-minute walk to the beach. A conversational follow-up requiring at least 2 bedrooms preserved dates, 2 adults and USD 500, produced NO_MATCHES and the `bedrooms` exclusion reason. No narration fallback occurred.
- Synthetic model check separately distinguished a shared pool, 1 full plus 2 half bathrooms, and a host-reported five-minute trip with unknown travel mode. This synthetic example does not describe the actual Demo property.
