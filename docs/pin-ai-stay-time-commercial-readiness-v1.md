# Pin AI stay-time commercial readiness V1

## Production audit — 2026-10-07

Backend #333 and Dashboard #177 are merged. Three stay-time/settings/cleaning-history/recovery migrations are applied. The existing quote, guest confirmation, free/paid application, signed Stripe event routing and canonical access/cleaning reconciliation are retained.

Production has the stay-time chat, action broker and proposal tool switches enabled, with two reservations in the ordinary date-change pilot. No stay-time modifications or unresolved STAY_TIME_RECOVERY_REVIEW issues were found. Only Pin&Go Demo Property has stay-time settings: early check-in USD 15 fixed to 12:00 and late checkout USD 15 fixed to 14:00. No host settings, prices, hours, consent or activation are changed by this work.

## Commercial eligibility

Early check-in and late checkout use the property's commercial Pin AI activation, current billing terms and recorded host consent, organization activation, Connect readiness, the current guest service window and at least one enabled host stay-time setting. Canonical quoting and confirmation still validate the exact requested operation, time, availability, cleaning and payment rules. Guest credentials resolve reservation and tenant scope on every operation; private confirmation credentials never enter model output.

Ordinary date changes and additional-night extensions remain restricted to the existing selected-reservation pilot. Commercial-only model sessions expose just EARLY_CHECKIN/LATE_CHECKOUT proposal arguments. When commercial availability/activation switches are off, the existing pilot remains unchanged. The four Pin AI USD 1 exemptions remain independent of stay-time prices and assistance.

## Recovery worker prepared, not deployed

Railway service `stay-time-recovery-worker` (`029c093d-f919-45df-86e9-37b6bbf4c9a9`) is staged in production patch `d445e002-d699-44ed-9b23-9f34bb89c421`. It follows backend main and starts `npx tsx src/workers/stay-time-recovery.worker.ts`, one us-west2 replica, continuous polling every 60 seconds, persisted leases/backoff and batches of at most 20. No HTTP domain, cron or API import is added. Build: locked npm install plus Prisma generation; existing applied migrations are not rerun by the worker.

The staged recovery-enabled flag is true. DB, Stripe, provider, access, communication and guest-journey policy variables reference the existing reservation-worker settings. Accepting this patch will run recovery, including fresh scoped provider evidence, canonical application/access/cleaning reconciliation and existing incremental-refund fallback. Recovery deliberately covers durable pending work across tenants and is not restricted by the chat canary. It does not create new proposals or guest consent, charge Pin AI USD 1 itself, or refund existing Pin AI fees.

Before accepting, review that the environment patch contains only this new worker. Merge the commercial eligibility PR only after its required checks pass. Deployment and host activation remain separate actions.

## Pending real validation

Casa Collores activation; real guest assistance/incidents; one-time USD 1 Direct Booking/OTA billing; and the complete early/late confirmation → payment → reservation → physical access → cleaning flow remain pending. Automated checks use synthetic fixtures/offline providers; they do not certify live Stripe charges, OTA delivery, locks or cleaner notifications. Services requested through chat remain an unapproved V2 proposal.
