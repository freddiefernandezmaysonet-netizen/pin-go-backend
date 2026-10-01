# Channex operational SMS eligibility

Production audit: PG-2026-000058 is an active, paid Airbnb reservation ingested through CHANNEX with externalId, phone present, email absent and no externalRaw.consent. Entry is October 2, 2026 at 16:00 America/Puerto_Rico. No delivery or physical-access certification is claimed.

Registration exemption PR #329 did not change SMS consent eligibility. Both the legacy worker and enterprise access outbox required Direct Booking-style consent evidence. This follow-up permits operational pre-check-in, access and checkout SMS for persisted CHANNEX + nonblank externalId. Explicit smsConsent=false or stayNotificationsConsent=false still blocks OTA SMS. Existing Direct Booking, manual and Lodgify behavior remains unchanged. No consent is written or fabricated; no marketing eligibility is granted.

The worker and outbox load persisted provenance; a provider inside externalRaw alone cannot qualify. Existing activation flags, provider suppression, payment/status/time checks and real credential evidence remain in their respective delivery paths. No data migration, backfill, forced send or reservation mutation.

Validation: targeted regression tests and strict TypeScript compilation. Real delivery remains pending deployment and the eligible reservation window.
