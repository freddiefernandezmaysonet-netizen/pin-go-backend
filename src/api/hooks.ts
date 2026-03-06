import { useQuery } from "@tanstack/react-query";
import { getDashboardOverview } from "./endpoints";
import { getDashboardProperties } from "./endpoints";
import { getDashboardLocks } from "./endpoints";

export function useDashboardReservations(params: {
  page: number;
  pageSize: number;
  status?: "ACTIVE" | "CANCELLED";
  propertyId?: string;
  from?: string;
  to?: string;
  search?: string;
  sort?: string;
}) {
  return useQuery({
    queryKey: ["dashboard", "reservations", params],
    queryFn: () => getDashboardReservations(params),
    keepPreviousData: true,
    staleTime: 10_000,
  });
}

export function useDashboardProperties() {
  return useQuery({
    queryKey: ["dashboard", "properties"],
    queryFn: getDashboardProperties,
    staleTime: 60_000, // properties cambian poco
  });
}

export function useDashboardLocks(params: {
  page: number;
  pageSize: number;
  propertyId?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ["dashboard", "locks", params],
    queryFn: () => getDashboardLocks(params),
    keepPreviousData: true,
    staleTime: 15_000,
  });
}

export function useDashboardAccess(params: { propertyId?: string }) {
  return useQuery({
    queryKey: ["dashboard", "access", params],
    queryFn: () => getDashboardAccess(params),
    staleTime: 10_000,
    keepPreviousData: true,
  });
}