import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { parsePinAIActionCanaryReservationIds } from "../actions/action-canary-scope.js";

export type HostEnvironment = Readonly<Record<string, string | undefined>>;
export class HostIncidentError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new HostIncidentError(status, code); };
export function hostScopeEnabled(env: HostEnvironment, org: string, reservation: string) {
  return env.PIN_AI_HOST_INCIDENT_ENABLED === "true" &&
    parsePinAIActionCanaryReservationIds(env.PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS).ids.has(org) &&
    parsePinAIActionCanaryReservationIds(env.PIN_AI_HOST_INCIDENT_RESERVATION_IDS).ids.has(reservation);
}
export type HostCommand = { requestId: string; expectedVersion: number;
  operation: "NOTE" | "ACKNOWLEDGE" | "PUBLISH" | "RESOLVE"; text: string };
export function parseHostCommand(value: unknown): HostCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "INVALID_REQUEST");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["requestId", "expectedVersion", "operation", "text"].includes(k)) ||
      typeof v.requestId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(v.requestId) ||
      !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 0 ||
      !["NOTE", "ACKNOWLEDGE", "PUBLISH", "RESOLVE"].includes(String(v.operation)) ||
      typeof v.text !== "string" || v.text.length > 4000 ||
      (v.operation === "ACKNOWLEDGE" ? v.text !== "" : !v.text.trim())) return fail(400, "INVALID_REQUEST");
  return v as HostCommand;
}
export function commandHash(actorId: string, command: HostCommand) {
  return createHash("sha256").update(JSON.stringify([actorId, command.operation, command.text, command.expectedVersion])).digest("hex");
}

// Versioned server-owned keyring, independent from guest tokens. Keep old keys
// until all corresponding ciphertext is migrated; unknown keys fail closed.
function key(env: HostEnvironment, id: string) {
  try {
    const keys = JSON.parse(env.PIN_AI_HOST_INCIDENT_KEYS ?? "{}");
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof keys[id] !== "string" || !/^[a-fA-F0-9]{64}$/.test(keys[id])) throw new Error();
    return Buffer.from(keys[id], "hex");
  } catch { return fail(503, "HOST_CONTENT_UNAVAILABLE"); }
}
export function sealHostContent(env: HostEnvironment, aad: string, text: string) {
  const id = env.PIN_AI_HOST_INCIDENT_KEY_ID ?? "";
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(env, id), iv);
  cipher.setAAD(Buffer.from(aad));
  return JSON.stringify({ v: 1, keyId: id, iv: iv.toString("hex"),
    data: Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64"), tag: cipher.getAuthTag().toString("hex") });
}
export function openHostContent(env: HostEnvironment, aad: string, value: string) {
  try {
    if (value.length > 30000) throw new Error();
    const e = JSON.parse(value); if (e.v !== 1) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(env, e.keyId), Buffer.from(e.iv, "hex"));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(e.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(e.data, "base64")), decipher.final()]).toString("utf8");
  } catch { return fail(503, "HOST_CONTENT_UNAVAILABLE"); }
}
