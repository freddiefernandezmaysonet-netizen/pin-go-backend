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

## Explicit saved trip plans — October 27

- Added opt-in save/update/remove for the single pilot member, using typed criteria and a title only. Plans are visibly PLANNING, with no reservation or held-price claim. The chat transcript is not persisted.
- The private volume stores up to 20 plans using schema validation, member binding, mode 0600 and atomic file replacement. Existing session and same-origin controls cover all plan endpoints. No database mutations or additional AI calls are introduced.
- Resuming a plan clears stale chat/results and submits its requirements to the existing search. Incomplete/past dates still go through the same date validation; current availability and pricing are queried when criteria are complete.
- Seventeen API/search/evidence/store test groups and two React interaction tests passed. New coverage: persisted plans after a fresh store/page, retry deduplication, updates at capacity, isolated deletion, corrupt/wrong-member file protection, private API access, cross-origin rejection, forbidden quote/history fields, fresh search on resume, edit/save and removal confirmation.
- Strict API/client TypeScript checks and the production Vite build passed. UI coverage is DOM interaction; authenticated desktop/mobile visual certification remains pending.
- Runtime commit `d56ee170bde914019d97b308aae01104f76258fc` deployed successfully to the isolated pilot (deployment `56361f73-e355-4f23-b3f6-0ce4d154f96f`). Startup confirms database read-only; `/health` is configured; the new client asset is served; unauthenticated plan reads return 401.
- The first external probe had a transient connection failure during rollout. Health, client and private endpoint checks subsequently passed, followed by the full authenticated live test.
- Live test passed: create a uniquely marked temporary plan, reload its criteria, resume with a fresh canonical Demo quote (USD 6.69 test tariff), update to 2 bedrooms plus private pool/walking proximity, preserve all requirements, and return NO_MATCHES with the bedroom exclusion. Cross-origin update/delete attempts returned 403.
- The temporary test plan was removed and all pre-existing plans were preserved. Save/update/remove/resume made zero OpenAI calls and did not create a reservation, charge or access grant.

## Demo participation and benefit drafts — October 27

- Read-only audit of backend main `af10a9d9191480d6b5b65f902abeb41859ece21a` found no Prime membership/property enrollment model; `PrimeNotifyState` is unrelated. No open backend PR matched Prime during the overlap check. Existing host routes use organization-scoped session identity; commercial enrollment still needs that identity/consent integration.
- Added founder-only **Anfitrión · Demo** controls inside the isolated pilot: ACTIVE/PAUSED participation and draft-only proposed benefits. Target property and actor are fixed server-side. The pre-existing Demo pilot remains active by default; this does not represent commercial host consent.
- Private state has schema validation, mode 0600, atomic replacement and expected revision checks. Paused state gates search before catalog reads and is rechecked after awaited work so an in-flight response cannot advertise a paused option. Corrupt enrollment returns an unavailable response.
- Discounts and other benefits remain private drafts and have no effect on canonical quotes, reservations, payments or NFC grants. Tests confirmed a 20% proposal leaves the original USD 385 fixture quote intact.
- Twenty API/search/evidence/store test groups and three React interaction tests passed. New coverage includes missing confirmation, arbitrary property rejection, session/origin checks, stale revisions, persistence, pause/resume, corrupted state, pause during generated narration, capability-gated UI and explicit reload after an edit conflict. Strict API/client TypeScript and the production build passed.
- React review covered hooks/dependencies, canceled initial loads, labels and status/error announcements, disabled conflicting saves, type-only server imports and four-item mobile navigation. Authenticated desktop/mobile visual certification remains pending.
- Runtime commit `5488d4b3ad26ee9582dad249693334146e37ee56` deployed successfully (deployment `52170127-b862-4399-9ddc-69070d60209a`). New client asset verified; startup confirms database read-only; the configuration API rejects unauthenticated reads with 401.
- Authenticated live test passed: active Demo returned its canonical USD 6.69 test quote; pausing returned CATALOG_PAUSED with no results; reactivation restored a result and the same USD 6.69 quote. The original ACTIVE setting and benefit draft were restored/preserved after the test.
- Live checks rejected arbitrary property input with 400, cross-origin updates with 403, and a stale revision with 409. The benefit draft was absent from guest search responses. The test made zero OpenAI calls and no booking, payment or access changes.

## Confirmed nightly discount range — October 27 (local, not deployed)

- The founder-only Demo configuration now requires 5–20% inclusive on new ACTIVE saves, with decimal percentages accepted. PAUSED can retain a valid percentage or an explicitly unset (`null`) draft. Client, HTTP and persistence validation reject out-of-range values; ACTIVE cannot be saved with an unset discount.
- Legacy v1 records remain readable and byte-for-byte unchanged on reads and invalid saves. The application does not choose a percentage or rewrite old settings automatically. An explicit successful save upgrades to v2; a paused unset draft requires a valid percentage before reactivation. Corrupt v2 state is rejected without replacement.
- Twenty-one server/API/search/store test groups and three React DOM interaction tests passed. Coverage includes 5%, 12.5% and 20%, empty/out-of-range input, legacy 0/30/100% drafts, pause/reactivation, persistent reload, file mode 0600, stale revisions, authenticated founder scope and unchanged quote amounts.
- Strict API TypeScript (`prime-pilot/*.ts`), client TypeScript, the Vite production build and whitespace checks passed. The React state type was narrowed to editable settings after strict checking caught a union-spread incompatibility. DOM interaction coverage is not desktop/mobile visual certification.
- This change is prepared on a separate branch based on the pilot branch. It is not deployed or merged into production. Membership checkout, commercial host enrollment, discount application, commissions and NFC grants are outside this change. The existing isolated pilot runtime remains pinned to `5488d4b3ad26ee9582dad249693334146e37ee56`.
- A rollback after v2 settings have been saved must retain v2 read support or restore the pre-upgrade Demo enrollment file before using the old v1-only runtime. Deployment and authenticated live verification remain pending.
