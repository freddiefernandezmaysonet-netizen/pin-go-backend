# Isolated discount certification — 2026-11-12

Backend runtime: 034bab87527d6d5244bcdaea0a0df7fe575a8eae; successful Railway deployment 72df357b-64f6-4a77-9747-713082d67264. Dashboard preview: d46ba8525878db28ad8ebcac977f662ec9f587e7 (based on feature head 5a3127a3a5cdcb6d8973e3eae57d5cfb366d4aea).

Only the certification branch changes the Vercel /backend rewrite to the isolated Railway service. Production rewrite and production configuration remain unchanged. Database schema direct_discounts_certification; synthetic organization/property only. Real auth and discount routers; injected auth disabled. Only login/session and discount configuration mutations are permitted. Runtime expires after two hours.

Authenticated HTTP certification passed 13 cases: unauthenticated denied; bad password denied; real login and scoped cookie; config read; save/read persistence; stale write 409; STACK total 747.40; BEST 781.10; disabled 856.00; cap 766.12; average nightly floor 781.10; excluded night 856.00; invalid config 400. Cleaning 75 and required amenity 25 remained unchanged. Initial synthetic configuration restored afterward.

Run with CERT_TEST_PASSWORD provided securely to node src/scripts/direct-discounts-api-certification.mjs. Never log credentials or run inline scripts that may echo credential values in uncaught errors.

Browser confirmed the preview reaches the login page through the test backend. Authenticated visual editor interaction remains unverified; HTTP tests are not a visual pass. Existing Stripe paid-webhook certification remains documented in direct-booking-discounts.md. No production merge or deployment performed.
