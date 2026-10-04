# Property arrival location V1

User-confirmed configuration to apply only after deployment and exact property
mapping verification: Serena Studio, complex `Las Palmas Doradas`, unit `107B`.
Channex property reference: `cda073df-9afc-44fb-ae88-bf60b0d277a0`.
No guest message or production data update was performed while developing this change.

## Behavior

- Optional Property.complexName (120 characters) and unitNumber (32 characters).
  Unit identifiers remain text, including letters and leading zeros.
- Authenticated create/edit APIs trim values, reject non-text/control characters
  and overlength values, preserve omitted fields and clear explicitly empty values.
- Dashboard create and edit forms expose both fields with labels and length limits.
- Arrival/access emails, arrival/access SMS and scoped Airbnb notifications include
  a localized separate location line. Property.name and the map address are unchanged.
- Access email retries and E7 access delivery load location from the current property.
  Legacy automatic/manual access SMS retries rebuild the text from the encrypted
  current grant instead of reusing a masked historical message body. They reject
  revoked/expired grants, changed stay dates or a changed recipient.
- The public booking detail endpoint uses its existing explicit field selection;
  these new arrival fields are not added to that public response.
- Blank location fields preserve existing message content.

## Release

Backend branch is stacked on Airbnb delivery PR #344, whose route remains OFF.
The additive migration `20261003160000_property_arrival_location` must run before
API/workers use the regenerated Prisma client. Publish the dashboard afterwards.
No automated Airbnb activation is implied by this property-field release.

After deployment, resolve the exact Serena Studio local property and organization
through the existing Channex mapping; save complexName and unitNumber through the
host property editor/API and read back. Do not infer the property from its name
alone or send a test message to its real guests. This is future-message configuration,
not a request to resend yesterday's access notification.

## Validation

Five focused behavioral tests cover validation, optional/cleared values,
alphanumeric units, localized arrival/access text and current credential retry
handling. Existing communications adapter, passcode SMS and Airbnb tests pass.
Backend guest-registration typecheck, API/worker ESM bundles, dashboard focused
TypeScript check and Vite production build pass. React review: labels are associated
with controls, unit input remains text, state uses existing form patterns and no
new data-fetching effects/dependencies are introduced. Live visual review and
migration/production verification remain release gates.
