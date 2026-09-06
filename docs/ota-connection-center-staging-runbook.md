# OTA Connection Center staging runbook

This runbook covers the separately authorized staging activation of the
white-label Connection Center. It does not authorize production activation,
data seeding, or changes to the certified Channex core.

## Safety invariants

- Keep `OTA_CONNECTION_CENTER_ENABLED` absent or `false` while configuring.
- Use only `https://staging.channex.io` for both provider API and iframe.
- Obtain channel filter identifiers from the Pin&Go Channex account or Channex
  partner documentation. Never infer them from Pin&Go provider enums.
- Never print the API key, one-time token, request headers, response bodies, or
  full iframe URL in logs or evidence.
- Use a dedicated Pin&Go staging organization and property.
- Do not activate or modify ARI, booking, webhook, ACK, deduplication, or worker
  behavior as part of this flow.

## Required configuration names

Configure these names first while the runtime flag remains off:

- `OTA_CONNECTION_PROVIDER_API_ORIGIN`
- `OTA_CONNECTION_API_KEY`
- `OTA_CONNECTION_IFRAME_BASE_URL`
- `OTA_CONNECTION_DEFAULT_CURRENCY`
- `OTA_CONNECTION_AIRBNB_FILTER`
- `OTA_CONNECTION_BOOKING_FILTER`
- `OTA_CONNECTION_HTTP_TIMEOUT_MS` (optional; defaults to `10000`)

Activation is controlled only by:

- `OTA_CONNECTION_CENTER_ENABLED`

The runtime remains disabled if any required value is absent, malformed, uses
HTTP, points outside the exact Channex staging/application origins, or mixes API
and iframe environments.

## Preflight

1. Confirm the OTA persistence migration is applied successfully.
2. Confirm the backend deployment SHA matches the approved release.
3. Confirm every backend and worker service is healthy.
4. Confirm the certified-core freeze test passes with SHA-256
   `085477095e14d087715407c3db7843e6b49a284e80f9a5a91a9a9a407148334b`.
5. Confirm the Connection Center mutation endpoint returns the disabled runtime
   response before activation.
6. Confirm the staging test property has the intended name, timezone, currency,
   room inventory, and no prior provider resources requiring reconciliation.

## Controlled staging sequence

1. Deploy the complete configuration with the runtime flag still off.
2. Reconfirm default-off behavior and zero provider requests.
3. Under separate authorization, enable the runtime for the controlled test.
4. Provision in order: Group, Property, primary Room Type, primary Rate Plan.
5. Confirm every returned identifier is checkpointed before proceeding.
6. Issue one one-time iframe session for one approved provider.
7. Confirm the browser accepts only the expected staging iframe origin.
8. Complete mapping and readiness verification using the Channex interface.
9. Capture only redacted evidence and stable Pin&Go status codes.

Stop immediately on a timeout, network failure, 5xx response, malformed success
response, or missing external identifier. These outcomes require reconciliation
and must not be retried automatically.

## Rollback

Set `OTA_CONNECTION_CENTER_ENABLED=false` and redeploy. This removes the
mutation capability without deleting provider resources or rolling back the
additive database schema. Reconcile any external resources before another
attempt.

## Official references

- <https://docs.channex.io/api-v.1-documentation/api-reference>
- <https://docs.channex.io/api-v.1-documentation/channel-iframe>
- <https://docs.channex.io/api-v.1-documentation/groups-collection>
- <https://docs.channex.io/api-v.1-documentation/room-types-collection>
- <https://docs.channex.io/api-v.1-documentation/rate-plans-collection>
