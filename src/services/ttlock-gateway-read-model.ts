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
      : null,
    gatewayId: input.gatewayId ?? null,
    gatewayName: input.gatewayName ?? null,
    gatewayStateSource: hasCanonicalState
      ? ("TTLOCK_GATEWAY" as const)
      : ("TTLOCK_GATEWAY_UNKNOWN" as const),
    gatewayLastEventAt: input.lastEventAt ?? null,
  };
}
