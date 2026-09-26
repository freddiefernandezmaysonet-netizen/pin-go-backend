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
  type PinAIReservationModificationActionAdapterDependencies,
} from "./reservation-modification-action-adapter.service.js";

const RESERVATION_MODIFICATION_SERVICE_MODULE =
  "../../services/guest-reservation-modification.service.js";
const RESERVATION_MODIFICATION_CHECKOUT_MODULE =
  "../../services/guest-reservation-modification-checkout.service.js";
const RESERVATION_MODIFICATION_APPLY_MODULE =
  "../../services/guest-reservation-modification-apply.service.js";

type ProviderModule =
  Readonly<Record<string, unknown>>;

async function loadProviderModule(
  modulePath: string,
): Promise<ProviderModule> {
  return await import(modulePath) as ProviderModule;
}

function requireProviderFunction<T extends (...args: any[]) => any>(
  module: ProviderModule,
  exportName: string,
): T {
  const value =
    module[exportName];

  if (typeof value !== "function") {
    throw new Error(
      `PIN_AI_ACTION_BROKER_PROVIDER_EXPORT_MISSING:${exportName}`,
    );
  }

  return value as T;
}

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
            await loadProviderModule(
              RESERVATION_MODIFICATION_SERVICE_MODULE,
            );
          const getPreview =
            requireProviderFunction<
              PinAIReservationModificationActionAdapterDependencies["getPreview"]
            >(
              module,
              "getGuestReservationModificationPreview",
            );

          return getPreview(request);
        },
      createProposal:
        createPinAIActionProposal,
      supersedeProposal:
        supersedePinAIActionProposal,
      confirmModification:
        async (request) => {
          const module =
            await loadProviderModule(
              RESERVATION_MODIFICATION_SERVICE_MODULE,
            );
          const confirmModification =
            requireProviderFunction<
              PinAIReservationModificationActionAdapterDependencies["confirmModification"]
            >(
              module,
              "confirmGuestReservationModification",
            );

          return confirmModification(
            request,
          );
        },
      createCheckout:
        async (request) => {
          const module =
            await loadProviderModule(
              RESERVATION_MODIFICATION_CHECKOUT_MODULE,
            );
          const createCheckout =
            requireProviderFunction<
              PinAIReservationModificationActionAdapterDependencies["createCheckout"]
            >(
              module,
              "createGuestReservationModificationCheckout",
            );

          return createCheckout(
            request,
          );
        },
      applyModification:
        async (request) => {
          const module =
            await loadProviderModule(
              RESERVATION_MODIFICATION_APPLY_MODULE,
            );
          const applyModification =
            requireProviderFunction<
              PinAIReservationModificationActionAdapterDependencies["applyModification"]
            >(
              module,
              "applyGuestReservationModification",
            );

          return applyModification(
            request,
          );
        },
      now,
    });

  return createPinAIActionBroker({
    prisma,
    reservationModification,
    now,
  });
}
