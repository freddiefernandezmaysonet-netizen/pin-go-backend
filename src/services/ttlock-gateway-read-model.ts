export function effectiveTtlockGatewayHealth(input: {
  canonicalOnline?: boolean | null;
  legacyConnected?: boolean | null;
  gatewayId?: number | null;
  gatewayName?: string | null;
  lastEventAt?: Date | null;
}) {
  const hasCanonicalState =
    input.canonicalOnline === true ||
    input.canonicalOnline === false;

  return {
    gatewayConnected: hasCanonicalState
      ? input.canonicalOnline!
      : input.legacyConnected ?? null,
    gatewayId: input.gatewayId ?? null,
    gatewayName: input.gatewayName ?? null,
    gatewayStateSource: hasCanonicalState
      ? ("TTLOCK_GATEWAY" as const)
      : ("LEGACY_DEVICE_HEALTH" as const),
    gatewayLastEventAt: input.lastEventAt ?? null,
  };
}
