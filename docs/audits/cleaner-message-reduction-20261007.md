# Existing cleaner SMS reduction proposal

Source audit, 2026-10-07. No sends, environment edits or production-volume queries. Proposal only.

| Existing family | Actual trigger in inspected source | Proposal |
|---|---|---|
| Availability confirmation | Cleaning confirmation dispatch, explicit accept link | Keep, including existing sequential backup offers |
| CLEANING_READY | Guest-access checkout/revocation path in reservation worker; sends the cleaner window | Remove routine SMS once My Cleanings reliably shows the assigned task/window |
| Cleaning start / NFC active | Staff-access activation path, gated by CLEANING_SMS_ENABLED=1 | Remove routine SMS; work Start remains explicit and independent of entry |
| Cleaning end / Access ended | Staff-access expiry/revocation path, gated by CLEANING_SMS_ENABLED=1 | Remove routine SMS; expiry does not prove work completion |
| START_REMINDER | Missing recorded start after scheduled start plus configured grace | Keep conditional |
| COMPLETION_REMINDER | Missing completion after scheduled start plus committed duration | Keep conditional |

The end SMS currently says cleaning done/limpieza terminada although its trigger is access revocation; this wording risks confusing entry expiry with actual completion. Removing the routine message avoids that ambiguity without changing access behavior. READY and NFC-active messages repeat schedule/access information available in My Cleanings, but they are distinct triggers, not proven duplicate production sends.

The normal successful flow would need only the availability SMS. Conditional reminders remain when cleaner actions are missing. A backup offer is an existing availability message to a different recipient and must remain. Host attention is a separate host email and is not counted as a cleaner SMS.

Potential reduction is up to three routine SMS per cleaning only when those paths actually send them. CLEANING_SMS_ENABLED runtime value was not inspected; code presence does not prove current sends. Dollar savings require actual message/segment volumes and billed costs; no numeric savings are certified.

No code changes or removals have been made for this proposal. Preserve Twilio integration, language selection, two-hour NFC scheduling and reminders' existing timing. Remove only notification calls after review, including their stale retry handling, while preserving access/work lifecycle writes.
