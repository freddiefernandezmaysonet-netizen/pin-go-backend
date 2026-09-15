import { readFileSync, writeFileSync } from "node:fs";

const path = "src/webhooks/stripe.webhook.ts";
let text = readFileSync(path, "utf8");

function replaceOnce(oldValue, newValue, label) {
  if (!text.includes(oldValue)) {
    throw new Error(`${label} anchor not found`);
  }
  text = text.replace(oldValue, newValue);
}

replaceOnce(
  `import {\n  handleGuestIdentityStripeEvent,\n  reconcileGuestIdentityVerificationSession,\n} from "../services/guest-identity-webhook.service";\n`,
  `import {\n  handleGuestIdentityStripeEvent,\n  reconcileGuestIdentityVerificationSession,\n} from "../services/guest-identity-webhook.service";\nimport {\n  claimStripeFinancialEvent,\n  markStripeFinancialEventFailed,\n  markStripeFinancialEventProcessed,\n} from "../services/stripe-financial-event-ledger.service";\n`,
  "ledger import"
);

replaceOnce(
  `      try {\n        // Mantener sync existente de Tuya sin romper nada\n`,
  `      let ledgerClaim;\n\n      try {\n        ledgerClaim = await claimStripeFinancialEvent(\n          prisma,\n          event\n        );\n      } catch (ledgerError: any) {\n        console.error(\n          "[STRIPE_FINANCIAL_EVENT_LEDGER_CLAIM_FAILED]",\n          {\n            eventId: event.id,\n            eventType: event.type,\n            error:\n              ledgerError?.message ?? ledgerError,\n          }\n        );\n\n        return res.status(500).json({\n          ok: false,\n          error: "stripe_event_ledger_claim_failed",\n        });\n      }\n\n      if (!ledgerClaim.shouldProcess) {\n        return res.json({\n          received: true,\n          type: event.type,\n          duplicate: true,\n          ledgerReason: ledgerClaim.reason,\n        });\n      }\n\n      try {\n        // Mantener sync existente de Tuya sin romper nada\n`,
  "ledger claim"
);

replaceOnce(
  `        return res.json({\n          received: true,\n          type: event.type,\n        });\n      } catch (err: any) {\n        console.error("🔥 Stripe webhook processing error:", err?.message ?? err);\n\n        return res.status(500).json({\n`,
  `        if (ledgerClaim.tracked) {\n          await markStripeFinancialEventProcessed(\n            prisma,\n            event.id\n          );\n        }\n\n        return res.json({\n          received: true,\n          type: event.type,\n        });\n      } catch (err: any) {\n        console.error("🔥 Stripe webhook processing error:", err?.message ?? err);\n\n        if (ledgerClaim.tracked) {\n          try {\n            await markStripeFinancialEventFailed(\n              prisma,\n              event.id,\n              err\n            );\n          } catch (ledgerError: any) {\n            console.error(\n              "[STRIPE_FINANCIAL_EVENT_LEDGER_FAILURE_MARK_FAILED]",\n              {\n                eventId: event.id,\n                eventType: event.type,\n                error:\n                  ledgerError?.message ?? ledgerError,\n              }\n            );\n          }\n        }\n\n        return res.status(500).json({\n`,
  "ledger completion/failure"
);

writeFileSync(path, text);
