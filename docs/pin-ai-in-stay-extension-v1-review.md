# Pin AI checkout-only extension — draft review

## Problem and evidence

Audited backend main on 2026-09-26: `7baba4192bbfbec5376738b62dd9fcb365f8fec9`.
The reviewed production guest turn used `check_date_change`, which returned
`PROPOSED_CHECK_IN_MUST_BE_IN_FUTURE`. It then used extension availability,
read-only pricing and shadow escalation. It did not call
`prepare_reservation_modification`. Historical root-agent instructions were shadow-only.
The trace did not expose the full available-tool catalog.

Separately, the canonical modification service rejects started reservations and
past/current proposed check-ins. Therefore enabling the action canary alone does
not certify checkout-only extension support. Resumed provider sessions also did
not refresh their tools or instructions.

## Changes

- Explicit `EXTEND_CHECKOUT_ONLY` operation for the existing reservation canary.
  Retains the stored check-in instant, occupants, and selected amenities.
- Added-night canonical pricing retains historical components, excludes a second
  cleaning/per-stay charge, validates snapshots and checks only the added interval.
- Canary read estimates use the same canonical preview as proposals. PRE_STAY and
  non-canary read estimates retain the prior path.
- Runtime preparation, broker, adapter, confirmation, checkout and apply recognize
  the extension operation with confirmation evidence, version/availability checks
  and existing payment evidence requirements.
- Guest runtime sessions carry a scope/configuration fingerprint. Missing or changed
  fingerprints cause replacement after busy-session guards. Matching sessions resume.
  Replacement carries at most 40 dialogue messages and 32,000 content characters,
  scoped to organization/property/reservation/guest. It excludes tool outputs.
  This configuration check applies to all Guest Gateway sessions, including read-only
  sessions; their first post-deployment message can replace a legacy session.
- The direct-booking pricing edit only narrows a nullable property variable for
  TypeScript; it does not change pricing formulas.
- No schema migrations, production variables, Stripe integration modules,
  OTA/Channex, Access or Messages engine changes.
  Existing downstream modification reconciliation remains in place and is not
  certified by this draft's mock-based tests.

## Local verification

- Baseline runtime/guest/property-knowledge suites: 166/166 pass.
- All baseline test names retained; combined current runtime/action/canonical suites:
  327/327 pass, zero skipped.
- Default read-only model, instructions and function schemas equal the baseline,
  including web search enabled/disabled configurations.
- Three scoped TypeScript builds pass: in-stay extension, action proposal runtime,
  and Guest Gateway. No claim of a repository-wide build.
- A gateway typecheck initially failed due to transitive canonical-service type
  imports; replaced with narrow runtime provider contracts and rebuilt successfully.
- Providers and persistence are injected/mocked. No live charges or reservation changes.

## Required before Ready/merge/deployment

1. Review CI results on the exact published head.
2. Verify OpenAI persists/returns configuration metadata; verify matching-session
   reuse, one-time legacy rotation, dialogue continuity and proposal tool visibility.
   If metadata is missing, the current implementation rotates again on each message.
3. Certify Guest Portal proposal rendering and canonical confirmation in an isolated
   environment. Production reservation changes and charges are not authorized.
4. Exercise actual PostgreSQL locking, concurrent requests, replay and apply transactions.
5. Expiry boundary correction is implemented and locally tested: paid extension
   proposals expire at the earlier of one hour or original checkout minus 30 minutes;
   proposals without additional payment expire no later than original checkout.
   Closed windows do not create proposals. Verify the displayed deadline in the portal.
6. Review impact of bounded history during rotation, including already resolved issues.

This is a draft for review, not production certification. No Ready, merge,
deployment, variable changes or live financial execution is authorized by this draft.
