import {
  createDefaultPinAIActionBroker,
} from "../actions/action-broker.composition.js";
import type {
  PinAIActionProposalRuntimeToolDependencies,
} from "./action-proposal-tool-executor.js";

const RESERVATION_MODIFICATION_SERVICE_MODULE =
  "../../services/guest-reservation-modification.service.js";

type ProviderModule =
  Readonly<Record<string, unknown>>;

type GetModificationOptions =
  PinAIActionProposalRuntimeToolDependencies[
    "getModificationOptions"
  ];

async function loadProviderModule(
  modulePath: string,
): Promise<ProviderModule> {
  return await import(
    modulePath
  ) as ProviderModule;
}

function requireProviderFunction<
  T extends (...args: any[]) => any,
>(
  module: ProviderModule,
  exportName: string,
): T {
  const value =
    module[exportName];

  if (
    typeof value !== "function"
  ) {
    throw new Error(
      `PIN_AI_ACTION_PROPOSAL_PROVIDER_EXPORT_MISSING:${exportName}`,
    );
  }

  return value as T;
}

export function createActionProposalRuntimeDependencies(
  input: Readonly<{
    guestToken: string;
    enabled: boolean;
    now?: () => Date;
  }>,
): Omit<
  PinAIActionProposalRuntimeToolDependencies,
  "delegate"
> {
  const broker =
    createDefaultPinAIActionBroker({
      now: input.now,
    });

  return {
    enabled:
      input.enabled,
    guestToken:
      input.guestToken,
    getModificationOptions:
      async (request) => {
        const module =
          await loadProviderModule(
            RESERVATION_MODIFICATION_SERVICE_MODULE,
          );
        const getOptions =
          requireProviderFunction<
            GetModificationOptions
          >(
            module,
            "getGuestReservationModificationOptions",
          );

        return getOptions(
          request,
        );
      },
    prepareReservationModification:
      (request) =>
        broker
          .prepareReservationModification(
            request,
          ),
  };
}
