# Persistent Host push registration

New native clients explicitly register with lifetime UNTIL_REVOKED. The API stores a nullable device expiresAt and returns persistent:true with expiresAt:null. Legacy requests retain the 30-day expiry. The additive migration only removes NOT NULL; it never renews or revives existing registrations.

The native app upgrades a dated binding once, while authenticated and with OS permission already granted. It does not show a background permission prompt or enable notification preferences. Deploy the API and migration before distributing the new native build. Older native builds cannot interpret persistent status; a downgrade should use a fresh login/legacy registration.

Delivery materialization, current authorization, and the final atomic send boundary all accept a null device expiry. Alert expiry remains 24 hours. Logout, security revocation, account switch, user authorization, preferences and provider DeviceNotRegistered retirement still apply. Provider invalidation is asynchronous; uninstall detection is not immediate.

Validation: 21 backend registry/HTTP/provider/delivery tests, one PGlite SQL integration test (including migration preservation, persistent authorization and revocation fences), 26 native notification/session tests, native TypeScript and strict registry/repository TypeScript pass.

## Continuous dispatcher rollout remains pending

The Railway host-mobile-push-once service was inspected on 2026-10-20. It still references the old certification branch/commit and an inline one-shot command, with restart NEVER. It is not the continuous dispatcher. No staged changes were present.

Before activation:
1. Merge and deploy reviewed backend changes and migrations.
2. Verify the exact production property IDs and organization scope from authoritative current data. Do not reuse IDs embedded in the old certification command without verification.
3. Preserve existing sealed token keys, provider access token and database reference. OAuth exposes names only, not their values.
4. Switch the source to reviewed deployed code, with delivery disabled during reconfiguration.
5. Set start command to node --import tsx src/workers/host-mobile-push.worker.ts --loop, restart ON_FAILURE, one replica and no cron. Confirm the build includes tsx and generated Prisma.
6. Configure HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS as the verified explicit JSON allowlist (maximum 50), HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE as activation UTC time, and HOST_MOBILE_PUSH_RESERVATIONS_ENABLED=true. Enable delivery only after reviewing configuration. Message delivery additionally requires its verifier configuration; do not assume every category is active.
7. Obtain authorization before a new EAS build. Install the updated Host app, sign in and preserve user preferences.
8. Run an authorized own-account reservation test, verify one push in background and correct tap destination, then verify timeout continuity and explicit opt-out. Provider acceptance alone does not prove a phone received it.

No production configuration, migration, notification, EAS build or public store submission was performed for this change.
