import { api } from "./client";

export type Me = {
  userId: string;
  email: string;
  orgId: string;
  orgName: string;
};

export type Overview = {
  activeReservations: number;
  checkInsToday: number;
  checkOutsToday: number;
  activeLocks: number;
  updatedAt: string;
};

export type ReservationsResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    id: string;
    guestName: string;
    guestEmail: string | null;
    roomName: string | null;
    checkIn: string;
    checkOut: string;
    status: "ACTIVE" | "CANCELLED";
    source: string | null;
    externalProvider: string | null;
    externalId: string | null;
    property: { id: string; name: string };
  }>;
};

export type LocksResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    id: string;
    ttlockLockId: number;
    name: string | null;
    isActive: boolean;
    updatedAt: string;
    property: { id: string; name: string };
    battery: number | null;
    batteryFresh: boolean;
  }>;
};

export type DashboardAccess = {
  now: string;
  guestPasscodes: Array<{
    grantId: string;
    reservationId: string | null;
    guestName: string;
    roomName: string | null;
    property: { id: string; name: string } | null;
    lock: { ttlockLockId: number; name: string | null } | null;
    startsAt: string;
    endsAt: string;
    codeMasked: string | null;
    ttlockKeyboardPwdId: number | null;
    lastError: string | null;
  }>;
  staffPasscodes: Array<{
    grantId: string;
    staffMember: { id: string; fullName: string | null } | null;
    lock: {
      ttlockLockId: number;
      name: string | null;
      property: { id: string; name: string };
    };
    startsAt: string;
    endsAt: string;
    codeMasked: string | null;
    ttlockKeyboardPwdId: number | null;
    lastError: string | null;
  }>;
  nfc: Array<{
    assignmentId: string;
    reservationId: string;
    guestName: string;
    roomName: string | null;
    property: { id: string; name: string };
    role: string;   // "GUEST" | "CLEANING"
    status: string; // "ACTIVE"...
    card: { id: string; label: string | null; ttlockCardId: number };
    startsAt: string;
    endsAt: string;
    lastError: string | null;
  }>;
};

export type PropertyLite = { id: string; name: string };

export function getDashboardProperties() {
  return api<{ items: PropertyLite[] }>("/api/dashboard/properties");
}

export function getMe() {
  return api<Me>("/api/me");
}

export function getDashboardOverview() {
  return api<Overview>("/api/dashboard/overview");
}

export function getDashboardReservations(params: {
  page?: number;
  pageSize?: number;
  status?: "ACTIVE" | "CANCELLED";
  propertyId?: string;
  from?: string;
  to?: string;
  search?: string;
  sort?: string;
}) {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  if (params.propertyId) q.set("propertyId", params.propertyId);
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.search) q.set("search", params.search);
  if (params.sort) q.set("sort", params.sort);

  return api<ReservationsResponse>(`/api/dashboard/reservations?${q.toString()}`);
}

export function getDashboardLocks(params: {
  page?: number;
  pageSize?: number;
  propertyId?: string;
  search?: string;
}) {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  if (params.propertyId) q.set("propertyId", params.propertyId);
  if (params.search) q.set("search", params.search);

  return api<LocksResponse>(`/api/dashboard/locks?${q.toString()}`);
}

export function getDashboardAccess(params?: { propertyId?: string }) {
  const q = new URLSearchParams();
  if (params?.propertyId) q.set("propertyId", params.propertyId);
  const qs = q.toString();
  return api<DashboardAccess>(`/api/dashboard/access${qs ? `?${qs}` : ""}`);
}