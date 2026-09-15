import { readFileSync, writeFileSync } from "node:fs";

const path = "src/workers/message.retry.worker.ts";
let text = readFileSync(path, "utf8");

const importAnchor = `import {
  isGuestJourneyCommunicationsOwnerScope,
  resolveGuestJourneyCommunicationsOwnerConfig,
} from "../services/guest-journey-communications-owner.config";
`;

if (!text.includes(importAnchor)) {
  throw new Error("checkout retry import anchor not found");
}

text = text.replace(
  importAnchor,
  `${importAnchor}import { evaluateCheckoutSmsConsent } from "../services/checkout-sms-consent.policy";\n`
);

const retryAnchor = `      log("Retrying SMS message", {
        id: msg.id,
        to: msg.to,
        channel: msg.channel,
        retryCount: msg.retryCount,
      });
`;

if (!text.includes(retryAnchor)) {
  throw new Error("checkout retry send anchor not found");
}

const retryGuard = `      if (String(msg.communicationType ?? "").toUpperCase() === "CHECKOUT") {
        const reservationId = String(msg.reservationId ?? "").trim();

        if (!reservationId) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: "CHECKOUT_SMS_RESERVATION_ID_MISSING",
            },
          });
          continue;
        }

        const reservation = await prisma.reservation.findUnique({
          where: { id: reservationId },
          select: { externalRaw: true },
        });

        if (!reservation) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: "CHECKOUT_SMS_RESERVATION_NOT_FOUND",
            },
          });
          continue;
        }

        const consentDecision = evaluateCheckoutSmsConsent(
          reservation.externalRaw
        );

        if (!consentDecision.allowed) {
          await prisma.messageLog.update({
            where: { id: msg.id },
            data: {
              status: "FAILED_FINAL",
              error: consentDecision.reason,
            },
          });

          log("Checkout SMS retry blocked", {
            id: msg.id,
            reservationId,
            reason: consentDecision.reason,
          });
          continue;
        }
      }

`;

text = text.replace(retryAnchor, retryGuard + retryAnchor);
writeFileSync(path, text);
