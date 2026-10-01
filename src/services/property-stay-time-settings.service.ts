import type { PrismaClient } from "@prisma/client";
import {
  defaultStayTimeSettings, parseStayTimeSettings, parseStayTimeSettingsUpdate,
  StayTimeSettingsError, validateStayTimeSettingsLimits,
} from "../pin-ai/actions/stay-time-settings.js";

export type StayTimeSettingsDb = Pick<PrismaClient, "property">;
const select = {
  id: true, organizationId: true, timezone: true, checkInTime: true, checkOutTime: true,
  stayTimeSettings: true, stayTimeSettingsRevision: true,
} as const;

async function property(db: StayTimeSettingsDb, organizationId: string, propertyId: string) {
  const row = await db.property.findFirst({ where: { id: propertyId, organizationId, status: "ACTIVE" }, select });
  if (!row) throw new StayTimeSettingsError("STAY_TIME_PROPERTY_NOT_FOUND", 404);
  return row;
}
function view(row: Awaited<ReturnType<typeof property>>) {
  let settings;
  try { settings = row.stayTimeSettings === null ? defaultStayTimeSettings() : parseStayTimeSettings(row.stayTimeSettings); }
  catch { throw new StayTimeSettingsError("STAY_TIME_STORED_SETTINGS_INVALID", 409); }
  return {
    propertyId: row.id, revision: row.stayTimeSettingsRevision, settings,
    timezone: row.timezone, checkInTime: row.checkInTime ?? "15:00", checkOutTime: row.checkOutTime ?? "11:00",
    currency: "USD" as const, executionAvailable: false as const,
  };
}
export async function getPropertyStayTimeSettings(db: StayTimeSettingsDb, organizationId: string, propertyId: string) {
  return view(await property(db, organizationId, propertyId));
}
export async function updatePropertyStayTimeSettings(
  db: StayTimeSettingsDb, organizationId: string, propertyId: string, body: unknown,
) {
  const { expectedRevision, settings } = parseStayTimeSettingsUpdate(body);
  const row = await property(db, organizationId, propertyId);
  if (row.stayTimeSettingsRevision !== expectedRevision) throw new StayTimeSettingsError("STAY_TIME_SETTINGS_CONFLICT", 409);
  validateStayTimeSettingsLimits(settings, row.checkInTime ?? "15:00", row.checkOutTime ?? "11:00");
  if (settings.earlyCheckin.enabled || settings.lateCheckout.enabled) {
    try {
      if (!row.timezone) throw new Error("Missing timezone");
      new Intl.DateTimeFormat("en", { timeZone: row.timezone }).format(new Date());
    } catch { throw new StayTimeSettingsError("STAY_TIME_PROPERTY_TIMEZONE_REQUIRED", 409); }
  }
  const result = await db.property.updateMany({
    where: {
      id: propertyId, organizationId, status: "ACTIVE", stayTimeSettingsRevision: expectedRevision,
      // Fence concurrent standard-hours/timezone edits as well as settings edits.
      checkInTime: row.checkInTime, checkOutTime: row.checkOutTime, timezone: row.timezone,
    },
    data: { stayTimeSettings: settings, stayTimeSettingsRevision: { increment: 1 } },
  });
  if (result.count !== 1) throw new StayTimeSettingsError("STAY_TIME_SETTINGS_CONFLICT", 409);
  return view({ ...row, stayTimeSettings: settings, stayTimeSettingsRevision: expectedRevision + 1 });
}
