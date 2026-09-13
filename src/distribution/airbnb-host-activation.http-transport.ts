import { resolveChannexRuntimeTransport } from "../lib/channex-runtime-transport.policy.js";

export class AirbnbActivationError extends Error {
  constructor(readonly code: string, readonly uncertain = false) {
    super(code);
    this.name = "AirbnbActivationError";
  }
}

export type AirbnbActivationTransport = { activate(channelId: string): Promise<void> };

// Channex's activation response is meta.message, not a JSON:API resource.
// This transport never retries a mutation or follows redirects.
export function createAirbnbActivationHttpTransport(args: {
  env: Readonly<Record<string, string | undefined>>;
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): AirbnbActivationTransport {
  const config = resolveChannexRuntimeTransport({
    env: args.env,
    nonProductionApiOrigin: args.apiOrigin,
    nonProductionApiKey: args.apiKey,
  });
  if (!["https://app.channex.io", "https://staging.channex.io"].includes(config.apiOrigin) ||
      !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 15000) {
    throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_CONFIGURATION_INVALID");
  }
  return {
    async activate(channelId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId)) {
        throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_CHANNEL_ID_INVALID");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        const response = await (args.fetchImpl ?? fetch)(
          `${config.apiOrigin}/api/v1/channels/${channelId}/activate`,
          { method: "POST", redirect: "error", signal: controller.signal,
            headers: { Accept: "application/json", "user-api-key": config.apiKey } }
        );
        if (response.status === 429) {
          throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RATE_LIMITED");
        }
        if ([401, 403, 404, 422].includes(response.status)) {
          throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_REQUEST_REJECTED");
        }
        if (response.status !== 200 || Number(response.headers.get("content-length")) > 65536) {
          throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) { await reader.cancel(); throw new Error("body limit"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof payload?.meta?.message !== "string") throw new Error("invalid response");
      } catch (error) {
        if (error instanceof AirbnbActivationError) throw error;
        throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true);
      } finally { clearTimeout(timer); }
    },
  };
}
