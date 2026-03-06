export function log(event: string, data: any = {}) {
  console.log(JSON.stringify({ level: "info", event, ts: new Date().toISOString(), ...data }));
}
export function warn(event: string, data: any = {}) {
  console.warn(JSON.stringify({ level: "warn", event, ts: new Date().toISOString(), ...data }));
}
export function err(event: string, data: any = {}) {
  console.error(JSON.stringify({ level: "error", event, ts: new Date().toISOString(), ...data }));
}