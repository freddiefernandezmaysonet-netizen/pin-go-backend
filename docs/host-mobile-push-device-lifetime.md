# Host push authorization: device lifetime

The iOS physical delivery test passed on 18 October 2026. Automatic dispatch
remains disabled pending this correction and rollout verification.

## Contract

Registration still requires a currently authorized interactive Host session.
Delivery uses the existing 30-day device expiry, with the exact registered
session/user/organization binding and current user token version. The passage
of the interactive 30-minute idle or 12-hour absolute deadline alone does not
invalidate the notification binding. No session timestamp is updated by push.

All persisted session revocations remain terminal, regardless of reason,
including logout, security revocation and a timeout recorded by an HTTP request.
This intentionally does not revive expired/revoked sessions. After reauthentication,
the client must register the device under the new session (currently through
Reconnect this device). A disconnected, expired or rebound device cannot be used
by an old delivery. Existing account, role, tenant, property, preference, source,
lease and quiet-hour checks remain enforced at the atomic send boundary.

Interactive HTTP sessions keep their existing limits. Opening a notification
may require login. Notification delivery is not permission to view its target.
Payloads continue to contain generic English text rather than guest data.

## Verification and rollout

Unit tests separate notification binding authorization from interactive session
validity. PostgreSQL tests exercise both snapshot and atomic send authorization
after 31 minutes and 13 hours, plus revocation between snapshot and send.
Existing tests retain token-version, role, organization, device, property,
preference, deduplication and crash-recovery checks.

Before activation: pass the PostgreSQL CI job; deploy the reviewed backend and
worker revision together; explicitly scope properties and the event cutoff;
verify a physical notification after inactivity and suppression after logout.
No migration, credential rotation, store build or automatic activation is part
of this correction. Android physical certification is still pending.

Guest-message production currently covers Channex NEEDS_HOST escalations in
HUMAN threads, not all inbound guest messages. This change does not broaden it.
