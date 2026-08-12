export type ChannexGlobalFeedActivation = {
  enabled: boolean;
  source: "DEFAULT_DISABLED" | "EXPLICIT";
  rawValue: string | null;
};

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveChannexGlobalFeedActivation(
  env: NodeJS.ProcessEnv = process.env
): ChannexGlobalFeedActivation {
  const rawValue = String(env.CHANNEX_GLOBAL_FEED_ENABLED ?? "").trim();

  if (!rawValue) {
    return {
      enabled: false,
      source: "DEFAULT_DISABLED",
      rawValue: null,
    };
  }

  const normalized = rawValue.toLowerCase();

  if (ENABLED_VALUES.has(normalized)) {
    return {
      enabled: true,
      source: "EXPLICIT",
      rawValue,
    };
  }

  if (DISABLED_VALUES.has(normalized)) {
    return {
      enabled: false,
      source: "EXPLICIT",
      rawValue,
    };
  }

  throw new Error(
    "CHANNEX_GLOBAL_FEED_ENABLED_INVALID: expected true/false, 1/0, yes/no, or on/off"
  );
}
