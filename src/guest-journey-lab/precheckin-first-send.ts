import type { PrismaClient } from "@prisma/client";
import { assertLabEnvironment } from "./isolation";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import { materializeScopedPrecheckin } from "../services/guest-journey-precheckin-materialization.service";

export function firstSendScope(revision: string) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(revision)) throw Error("FIRST_SEND_REVISION_INVALID");
  return { organizationId: "gj_lab_organization", propertyId: `gj_lab_first_property_${revision}` };
}
export const firstSendReservationId = (revision: string, scenario: string) => `gj_lab_${revision}_first_${scenario}`;
export async function materializeFirstPrecheckin(
  db: PrismaClient, revision: string, reservationId: string, now: Date,
  dependencies = { persistAudit: persistAuditEntry },
) {
  assertLabEnvironment(process.env);
  const scope = firstSendScope(revision);
  if (!reservationId.startsWith(`gj_lab_${revision}_first_`)) throw Error("FIRST_SEND_RESERVATION_SCOPE_MISMATCH");
  return materializeScopedPrecheckin(db, scope, reservationId, now, dependencies);
}
