import { prisma } from "../../lib/prisma.js";
import {
  createPinAIActionProposal,
  supersedePinAIActionProposal,
} from "./action-proposal.service.js";
import {
  createPinAIActionBroker,
} from "./action-broker.service.js";
import {
  PinAIReservationModificationActionAdapter,
} from "./reservation-modification-action-adapter.service.js";

export function createDefaultPinAIActionBroker(
  input: Readonly<{
    now?: () => Date;
  }> = {},
) {
  const now =
    input.now ??
    (() => new Date());

  const reservationModification =
    new PinAIReservationModificationActionAdapter({
      prisma,
      getPreview:
        async (request) => {
          const module =
            await import(
              "../../services/guest-reservation-modification.service.js"
            );
          return module
            .getGuestReservationModificationPreview(
              request,
            );
        },
      createProposal:
        createPinAIActionProposal,
      supersedeProposal:
        supersedePinAIActionProposal,
      confirmModification:
        async (request) => {
          const module =
            await import(
              "../../services/guest-reservation-modification.service.js"
            );
          return module
            .confirmGuestReservationModification(
              request,
            );
        },
      createCheckout:
        async (request) => {
          const module =
            await import(
              "../../services/guest-reservation-modification-checkout.service.js"
            );
          const result =
            await module
              .createGuestReservationModificationCheckout(
                request,
              );

          return {
            checkoutUrl:
              result.checkoutUrl,
            checkoutExpiresAt:
              result.checkoutExpiresAt,
          };
        },
      applyModification:
        async (request) => {
          const module =
            await import(
              "../../services/guest-reservation-modification-apply.service.js"
            );
          const result =
            await module
              .applyGuestReservationModification(
                request,
              );

          return {
            modification:
              result.modification,
          };
        },
      now,
    });

  return createPinAIActionBroker({
    prisma,
    reservationModification,
    now,
  });
}
