import crypto from "node:crypto";

type CanonicalJsonPrimitive = null | boolean | number | string;

type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type ChannexAriCanonicalJsonIntegrity = {
  serialized: string;
  payloadBytes: number;
  payloadHash: string;
};

function canonicalizeJsonValue(
  value: unknown,
  ancestors: WeakSet<object>
): CanonicalJsonValue {
  if (value === null) return null;

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("CHANNEX_ARI_CANONICAL_JSON_NUMBER_INVALID");
    }

    return value;
  }

  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error("CHANNEX_ARI_CANONICAL_JSON_VALUE_UNSUPPORTED");
  }

  if (ancestors.has(value)) {
    throw new Error(
      "CHANNEX_ARI_CANONICAL_JSON_CIRCULAR_REFERENCE"
    );
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        canonicalizeJsonValue(item, ancestors)
      );
    }

    const prototype = Object.getPrototypeOf(value);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error(
        "CHANNEX_ARI_CANONICAL_JSON_OBJECT_UNSUPPORTED"
      );
    }

    const record = value as Record<string, unknown>;
    const canonical: Record<string, CanonicalJsonValue> = {};

    for (const key of Object.keys(record).sort()) {
      canonical[key] = canonicalizeJsonValue(
        record[key],
        ancestors
      );
    }

    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

export function stringifyChannexAriCanonicalJson(
  value: unknown
): string {
  return JSON.stringify(
    canonicalizeJsonValue(value, new WeakSet<object>())
  );
}

export function calculateChannexAriCanonicalJsonIntegrity(
  value: unknown
): ChannexAriCanonicalJsonIntegrity {
  const serialized =
    stringifyChannexAriCanonicalJson(value);

  return {
    serialized,
    payloadBytes: Buffer.byteLength(serialized, "utf8"),
    payloadHash: crypto
      .createHash("sha256")
      .update(serialized)
      .digest("hex"),
  };
}
