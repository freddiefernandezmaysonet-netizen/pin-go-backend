# Host mobile push registry — prepared backend

The native backend routes are mounted under /api/host-mobile/notifications, independently of incident feature availability. HOST_MOBILE_PUSH_REGISTRATION_ENABLED must explicitly be true; its default is off. No deployment or activation was performed.

POST /devices accepts only an Expo push token, platform ios/android and the exact Host EAS project f7037a5c-4526-46d7-b7bb-fb56e2be2f8f. User/organization/session come from a signed current session in ENFORCE mode and current Host role. Cookie/Origin requests fail closed. Token text is encrypted with an independent versioned server-owned keyring (HOST_MOBILE_PUSH_TOKEN_KEYS, HOST_MOBILE_PUSH_TOKEN_KEY_ID), scoped as authenticated data to organization, user, session and token hash. Never put keys or tokens in chat, logs or Git. The server returns registration status only. No key was created or configured here.

A token hash has one binding. Possession of the token permits rebinding on account switch; replacement changes actor/session scope and ciphertext atomically. DELETE /devices/session retires only the current actor's current session bindings. Registrations expire after 30 days, but expiry is not a substitute for current session validation at dispatch.

GET /preferences returns only the current actor's settings, default disabled. PUT /preferences accepts explicit enabled/kinds/timezone/quietHours/expectedRevision and uses a serializable version check. Lost update responses require GET readback; never silently replay a stale revision. Preference changes do not alter existing email/SMS rules.

The schema/migration now adds three tables, including the metadata-only delivery ledger described in docs/host-mobile-push-delivery.md. CI applies the migration only to the isolated Host test database and exercises uniqueness, preference concurrency and scoped retirement. Local 19 Host tests passed; three PostgreSQL suites were skipped locally and must pass remotely. HTTP tests cover current signed sessions, revoked session, changed role, unavailable validation, denied Cookie/Origin transports, invalid tokens and disabled registration. Prisma schema validation and TypeScript passed.

Companion Host PR7 already includes native permission/token integration, preferences, logout cleanup and authorized tap navigation; its exact-head runs 39015236036 and 39015235991 passed. The new disabled delivery candidate adds durable source/device work, fenced dispatch, strict token decryption and ticket/receipt recovery. See docs/host-mobile-push-delivery.md for supported sources, configuration, uncertainty and remaining release gates. Physical delivery, inbound guest-message production, retention maintenance, operational reconciliation and provider setup remain incomplete. The registry routes themselves send no notification. Keep all sending disabled until current-head integration evidence and controlled physical certification are reviewed.


## Current-device status

POST /api/host-mobile/notifications/devices/status uses the same native Host
session guard and rate limit as registration. Its JSON body is the existing
registration shape: token, platform and the exact Host projectId. It hashes the
supplied token in memory and looks up only an unrevoked, unexpired binding owned
by the exact current user, organization and session. The response contains only
ok and device: {registered, expiresAt}; an absent or foreign binding returns
registered:false and expiresAt:null. It never returns the token, hash, ciphertext,
device ID, other owner or other session. Status reads never renew/rebind devices.
The mobile client must display unknown status on transport/unsupported-endpoint
failure and must not infer registration from saved alert preferences. Successful
registration is confirmed through this status readback. A new login requires an
explicit reconnection. No migration or automatic delivery activation is required.
