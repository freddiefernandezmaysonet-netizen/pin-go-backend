import {
  commercialPinAIEnabled,
  type ActivationDb,
  type ActivationEnvironment,
  type ActivationScope,
} from "./property-activation.js";

// Informational guidance may be shown before the reservation's chat window.
// Only a positive commercial activation can advertise the service; pilot/null,
// disabled controls, missing scope and lookup failures must hide it.
export async function guestPinAIInformationEnabled(
  db: ActivationDb,
  env: ActivationEnvironment,
  scope: ActivationScope,
): Promise<boolean> {
  if (env.PIN_AI_GUEST_GATEWAY_ENABLED !== "true" ||
      !scope.organizationId || !scope.propertyId) return false;
  try {
    return await commercialPinAIEnabled(db, env, scope) === true;
  } catch {
    // Optional service information must not interrupt booking or confirmation.
    return false;
  }
}
