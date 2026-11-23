# Guest Journey delivery integration and rollout

## Scope and current evidence

This integration collects the isolated lab and receipt work from #531–#536 against main. It includes additive receipt storage, transport-account provenance, account/tenant-scoped outcome writes, and an opt-in recovery worker. The synthetic integrated first-send scenario passes through materialization, E7 dispatch, early receipt capture, reconnect, receipt recovery and E7 reconciliation without dispatching twice.

Passing simulation does not establish live provider delivery or production first-send readiness. The lab is deliberately configured without provider credentials and blocks external network calls.

## Remaining production gates

- Review all production changes in the aggregate diff, including changes inherited from the lab branch (mission control, pre-check-in timing and delivery adapter).
- Confirm the production first-send materializer, owner-cycle invocation and E7 reconciliation scheduling. The tested lab entry points are not a production scheduler; receipt recovery updates delivery evidence but does not itself complete an E7 intent.
- Confirm the account namespace used for sending matches verified webhook capture. Resend namespaces are server-owned, stable per account and never reused for another account.
- In CAPTURE mode both verified webhook handlers retain the receipt and acknowledge it. The recovery worker applies it after a unique account and tenant match. OFF preserves legacy immediate recording. Capture affects the entire endpoint. Use an isolated callback endpoint for the canary, or verify binding coverage for all its traffic first. Historical unbound messages stay pending.
- Resolve the unrelated OTA narrow-file certification and Mobile Access createUser contract failures through their respective owners. Do not change Channex certification to bypass them.
- Require a production canary restricted to the two recipient destinations provided privately in the conversation. Do not put personal contact data or secrets in source control.

## Deployment order

1. Review and merge the aggregate change only after the remaining gates are resolved. Do not merge the stacked drafts separately as well.
2. Apply the three additive receipt/account migrations before starting code generated from the new Prisma schema.
3. Deploy with MESSAGE_DELIVERY_RECEIPT_INBOX_MODE=OFF, MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED=0 and MESSAGE_DELIVERY_RECEIPT_RECOVERY_MODE=OFF. Verify existing sends and webhooks remain healthy.
4. Configure and verify signed provider callback endpoints and the intended sender/account mappings. Keep secrets in Railway variables.
5. Implement and verify a recipient and property allowlist plus a bounded canary run before enabling first sends. The current global flags alone do not enforce recipient restrictions.
6. Enable binding and capture for the controlled run. Observe provider acceptance, authenticated receipt retention, matching account and tenant, then enable recovery and scheduled E7 reconciliation only within the reviewed scope.
7. Send one email and one SMS to the approved test destinations. Record provider IDs, delivery evidence, receipt acknowledgement and final E7 state. Acceptance alone is not delivery.
8. Repeat recovery and the owner tick and prove the provider-call count does not increase. Do not retry an ambiguous accepted send.
9. Expand beyond the canary only after its actual delivery and duplicate-prevention evidence is reviewed.

## Rollback

Stop the dedicated recovery worker and disable recovery, capture and account binding. Stop new first-send execution through its production scope control. Preserve receipt records, message identifiers, account provenance and processing acknowledgements; do not delete evidence or reset uncertain send fences. Roll back application code to the previously recorded deployment as needed, leaving the additive schema in place. A timeout or missing receipt requires investigation, not an automatic resend.

## Operational checks

Track pending receipt count/age, unmatched and ambiguous correlations, processing errors, and E7 intents waiting for evidence. Recovery processes at most 50 receipts per transaction and retries pending correlations after 30 seconds. Its standalone command is:

`node --import tsx src/workers/message-delivery-receipt-recovery.worker.ts`

This document is a deployment plan, not evidence that any production change has occurred.
