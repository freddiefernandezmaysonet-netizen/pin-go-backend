# Prime pilot verification — October 27, 2026

## Passed

- TypeScript: strict check of the pilot API, catalogue adapter, and React client.
- Vite production build: passed; client bundle about 70 kB gzip, no credential values in client source.
- Seven search/HTTP tests: passed. Catalogue isolation; unavailable dates; full-price budget; invalid dates; occupancy, child/infant and feature checks; upstream failures; one-use provisioning; unsigned/forged session rejection; same-origin policy; daily AI quota; signed HttpOnly cookie and logout.
- One React DOM interaction test: passed with clearly isolated fixtures. Explore/Card/Trips navigation, Spanish/English, example search, criteria update, empty results and sign-out. This is not a browser layout or real-device certification.
- Two real OpenAI calls using the new isolated Prime key: successful. Initial request extracted Puerto Rico, November 6–9, two adults, total USD 500. Follow-up changed to November 13–16 and added private pool + NFC while retaining the other criteria.
- Railway startup verified PostgreSQL `default_transaction_read_only=on` before listening.
- Live read-only search against Demo, November 6–9, two adults: one available result, zero failures. The canonical pricing service returned USD 6.69 total (the existing Demo test tariff); this is not a commercial offer. No data was written.

## Pending

- Creation of the public HTTPS domain was denied by automatic approval review because explicit permission to expose this new service to the Internet was required. No alternate public endpoint was created.
- The new OpenAI key is saved locally in the ignored `.env.prime.local` and is not yet provisioned to the pilot. The authenticated HTTPS provisioning step awaits that domain.
- End-to-end browser verification, mobile visual review, and the founder's test await the HTTPS endpoint. Local browser rendering was unavailable in this environment; no screenshots or device certification are claimed.
- Prime permanent accounts, host opt-in, commercial benefits/prices, booking checkout, member trip linkage, and automatic NFC reservation grants are not part of this pilot.

Production `OPENAI_API_KEY`, public booking settings, production API routes, workers, existing reservations, payments, and access grants were not changed.
