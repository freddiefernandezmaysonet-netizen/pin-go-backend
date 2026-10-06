import type { Prisma, PrismaClient } from "@prisma/client";

export const INTERNAL_DEMO_PROPERTY_ID = "cmomyua8b0001rv1dvl6xjr6g";
export const INTERNAL_DEMO_SOURCE = "INTERNAL_DEMO_DIRECT_BOOKING";
export const INTERNAL_DEMO_PROVIDER = "PIN_GO_INTERNAL_DEMO";

export function hasDemoMarker(r: { source?: string | null; externalProvider?: string | null }) {
  return r.source === INTERNAL_DEMO_SOURCE || r.externalProvider === INTERNAL_DEMO_PROVIDER;
}

export const demoReservationWhere = {
  propertyId: INTERNAL_DEMO_PROPERTY_ID, source: INTERNAL_DEMO_SOURCE,
  externalProvider: INTERNAL_DEMO_PROVIDER, externalId: { startsWith: "DEMO-" },
  AND: [
    { externalRaw: { path: ["demo"], equals: true } },
    { externalRaw: { path: ["paymentSimulated"], equals: true } },
  ],
} satisfies Prisma.ReservationWhereInput;

export function isInternalDemo(r: { source?: string | null; externalProvider?: string | null;
  externalId?: string | null; propertyId?: string; externalRaw?: unknown;
  property?: { status?: string } | null }) {
  const raw = r.externalRaw as Record<string, unknown> | null;
  return r.propertyId === INTERNAL_DEMO_PROPERTY_ID && r.source === INTERNAL_DEMO_SOURCE &&
    r.externalProvider === INTERNAL_DEMO_PROVIDER && !!r.externalId?.startsWith("DEMO-") &&
    !!raw && !Array.isArray(raw) && raw.demo === true && raw.paymentSimulated === true &&
    r.property?.status === "ACTIVE";
}

export async function readInternalDemo(db: Pick<PrismaClient, "reservation"> | Pick<Prisma.TransactionClient, "reservation">,
  scope: { reservationId: string; organizationId: string; propertyId?: string; guestToken?: string }) {
  if (scope.propertyId && scope.propertyId !== INTERNAL_DEMO_PROPERTY_ID) return null;
  return db.reservation.findFirst({ where: { ...demoReservationWhere,
    id: scope.reservationId, property: { organizationId: scope.organizationId, status: "ACTIVE" },
    ...(scope.guestToken ? { guestToken: scope.guestToken, guestTokenExpiresAt: { gt: new Date() } } : {}),
  } });
}

// Extend only the local invocation's incident scope after a canonical DB check.
// Financial/action canaries and global environment configuration are untouched.
export function demoIncidentEnvironment(env: Readonly<Record<string, string | undefined>>,
  org: string, reservation: string): Record<string, string | undefined> {
  const append = (key: string, value: string) => [...new Set([...(env[key] ?? "").split(",").filter(Boolean), value])].join(",");
  return { ...env,
    PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: append("PIN_AI_INCIDENT_CANARY_RESERVATION_IDS", reservation),
    PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: append("PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS", org),
    PIN_AI_HOST_INCIDENT_RESERVATION_IDS: append("PIN_AI_HOST_INCIDENT_RESERVATION_IDS", reservation),
  };
}
