export const TUYA_ENABLED = process.env.TUYA_ENABLED === "true";
export const TUYA_BASE_URL = (process.env.TUYA_BASE_URL ?? "").replace(/\/+$/, "");
export const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID ?? "";
export const TUYA_CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET ?? "";

export function assertTuyaEnv() {
  if (!TUYA_BASE_URL) throw new Error("TUYA_BASE_URL missing");
  if (!TUYA_CLIENT_ID) throw new Error("TUYA_CLIENT_ID missing");
  if (!TUYA_CLIENT_SECRET) throw new Error("TUYA_CLIENT_SECRET missing");
}