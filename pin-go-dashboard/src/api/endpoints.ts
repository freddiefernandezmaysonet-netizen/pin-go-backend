import { api } from "./client";

export type Overview = {
  activeReservations: number;
  checkInsToday: number;
  checkOutsToday: number;
  activeLocks: number;
  updatedAt: string;
};

export type PropertyLite = { id: string; name: string };

export function getDashboardOverview() {
  return api<Overview>("/api/dashboard/overview");
}

export function getDashboardProperties() {
  return api<{ items: PropertyLite[] }>("/api/dashboard/properties");
}