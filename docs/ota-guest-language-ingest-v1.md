# OTA guest language ingestion

Channex customer.language is documented at https://docs.channex.io/api-v.1-documentation/bookings-collection. The current lifecycle already passes the unchanged normalized booking under externalRaw.booking. Reservation ingestion now reads externalRaw.booking.customer.language for persisted CHANNEX + nonempty externalId.

English and Spanish (including regional forms) are supported. Unknown, absent, blank or malformed values produce no language patch. Existing reservations keep their language; new reservations retain the schema default en. Explicit supported OTA values update the language on revisions accepted by existing lifecycle ordering rules. Direct Booking and other providers retain their existing normalization.

Pre-checkin, passcode and checkout messages already consume Reservation.preferredLanguage. No new templates, schema change, production backfill, sends or reprocessing are included. Previously imported reservations require a later accepted revision to acquire their OTA language; historical English defaults are not corrected by this deployment alone.

Validation: targeted language, registration, cancellation and communication regressions; strict TypeScript/emitted compilation including ingestion and reservation/message workers. Certified Channex transport core remains byte-for-byte unchanged.
