# Guest Journey delivery integration and rollout

## Scope and current evidence

This integration collects the isolated lab and receipt work from #531–#536 against main. It includes additive receipt storage, transport-account provenance, account/tenant-scoped outcome writes, and an opt-in recovery worker. The synthetic integrated first-send scenario passes through materialization, E7 dispatch, early receipt capture, reconnect, receipt recovery and E7 reconciliation without dispatching twice.

Passing simulation does not establish live provider delivery or production first-send readiness. The lab is deliberately configured without provider credentials and blocks external network calls.

## Remaining production gates

- Review all production changes in the aggregate diff, including changes inherited from the lab branch (mission control, pre-check-in timing and delivery adapter).
- The reservation worker invokes the opt-in first-send producer, E7 owner and pending delivery reconciliation once per cycle. Its ordinary E7 owner excludes the reserved canary reason code.
- Confirm the account namespace used for sending matches verified webhook capture. Resend namespaces are server-owned, stable per account and never reused for another account.
- In CAPTURE mode both verified webhook handlers retain the receipt and acknowledge it. The recovery worker applies it after a unique account and tenant match. OFF preserves legacy immediate recording. Capture affects the entire endpoint. Use an isolated callback endpoint for the canary, or verify binding coverage for all its traffic first. Historical unbound messages stay pending.
- Resolve the unrelated OTA narrow-file certification and Mobile Access createUser contract failures through their respective owners. Do not change Channex certification to bypass them.
- Require a production canary restricted to the two recipient destinations provided privately in the conversation. Do not put personal contact data or secrets in source control.

## Deployment order

1. Review and merge the aggregate change only after the remaining gates are resolved. Do not merge the stacked drafts separately as well.
2. Apply the three additive receipt/account migrations before starting code generated from the new Prisma schema.
3. Deploy with MESSAGE_DELIVERY_RECEIPT_INBOX_MODE=OFF, MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED=0 and MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE=OFF. Verify existing sends and webhooks remain healthy.
4. Configure and verify signed provider callback endpoints and the intended sender/account mappings. Keep secrets in Railway variables.
5. Configure the reservation worker with GUEST_JOURNEY_CANARY_ORGANIZATION_ID, GUEST_JOURNEY_CANARY_PROPERTY_ID, GUEST_JOURNEY_CANARY_RESERVATION_ID, GUEST_JOURNEY_CANARY_EMAIL and GUEST_JOURNEY_CANARY_SMS. Choose a fresh paid direct-booking test reservation with a Guest Journey and SMS consent. Verify all legacy senders have upgraded and finished in-flight work before the reservation enters the four-hour pre-check-in window. Check for existing deliveries or retry jobs. An existing effect blocks E7 materialization on that channel.
6. Configure and verify account binding, signed capture and receipt recovery first. Set GUEST_JOURNEY_CANARY_EXECUTE=1 on the reservation worker for the controlled run. Match both stored destinations exactly. The worker reserves each eligible channel with an E7_OWNED dispatch record. Legacy senders must retain and honor those records when the canary flag is turned off.
7. Send one email and one SMS to the approved test destinations. Record provider IDs, delivery evidence, receipt acknowledgement and final E7 state. Acceptance alone is not delivery.
8. Repeat recovery and the owner tick and prove the provider-call count does not increase. Do not retry an ambiguous accepted send.
9. Expand beyond the canary only after its actual delivery and duplicate-prevention evidence is reviewed.

## Rollback

Stop the dedicated recovery worker and disable recovery, capture and account binding. Set GUEST_JOURNEY_CANARY_EXECUTE=0 and let active ticks finish. Before reverting to code that predates E7_OWNED, move the test reservation outside legacy eligibility and confirm all in-flight sends have settled. Preserve receipt records, message identifiers, account provenance and processing acknowledgements; do not delete evidence or reset uncertain send fences. Roll back application code to the previously recorded deployment as needed, leaving the additive schema in place. A timeout or missing receipt requires investigation, not an automatic resend.

## Operational checks

Track pending receipt count/age, unmatched and ambiguous correlations, processing errors, and E7 intents waiting for evidence. Recovery processes at most 50 receipts per transaction and retries pending correlations after 30 seconds. Its standalone command is:

`node --import tsx src/workers/message-delivery-receipt-recovery.worker.ts`

This document is a deployment plan, not evidence that any production change has occurred.
