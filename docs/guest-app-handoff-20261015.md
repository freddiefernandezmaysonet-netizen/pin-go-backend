# Guest portal → installed app handoff

The Guest release at `5a1cbd915f08c5c744d92df7ca20658294f118fb` contains the Reservar, Stay, Access, Pin AI and Help tabs. Its signed-out screen does not expose those tabs. A valid `pingo-guest://stay/<token>` link exchanges the stay token for a device session; reopening the app restores that session from SecureStore.

The web portal previously offered no native handoff. Completing an EAS upload or installing TestFlight did not verify this onboarding path.

This change adds an explicit HTTPS landing page at `/guest/app/:token`, offered by the access portal and completed registration page. The landing page checks token expiry, active reservation/property, checkout and stay-link revocation before rendering the custom-scheme button. It also keeps a browser continuation to the existing registration portal. No automatic redirects, store assumptions, SMS consent requirement, notifications, or email dispatch are introduced. Existing pre-check-in email delivery remains independent from optional SMS.

Opening the app does not mark registration complete, release physical access, or enable confirmation/Bluetooth features. Current backend access policies remain authoritative.

## Verification

`Guest App Handoff` CI uses a disposable PostgreSQL database and synthetic fixtures only. It exercises the actual HTTP landing page, the native link URL contract, real Prisma session exchange and restoration, blocked access-code disclosure, revoked/expired sessions, Spanish instructions, invalid/expired/cancelled/ended/revoked links, and inactive properties. Existing email fallback and mobile authorization tests run alongside it. The current Guest release parser (cold/warm) and 18 native session-storage scenarios passed locally against its release source; CI does not fetch that separate repository or require additional credentials.

These are automated integration checks, not physical-device certification. Email inbox delivery and opening the button from a real iPhone/Android browser must still be verified after an approved deployment. The new backend page must be integrated and deployed before it is available to guests. This PR neither deploys the page nor uploads a new binary. The existing custom-scheme contract is reused, but compatibility with the exact installed TestFlight build remains a physical-device check.

## Manual acceptance after deployment

1. Use an authorized test reservation whose guest declines SMS; confirm the normal transactional email arrives with its private HTTPS portal link.
2. Complete required registration in the browser, then choose Pin&Go Guest and open the app. Confirm the correct reservation and all five tabs.
3. Close/reopen the app and confirm it restores the same stay. Check the same link while the app is already open.
4. Without an installed app, continue in the browser and complete the stay flow there. A cancelled/expired/revoked link must not offer native entry.
5. Check both physical platforms; never paste real private links into logs, screenshots or PR comments.
