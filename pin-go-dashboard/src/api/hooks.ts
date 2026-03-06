import { useQuery } from "@tanstack/react-query";
import { getDashboardOverview, getDashboardProperties } from "./endpoints";

export function useDashboardOverview() {
  return useQuery({
    queryKey: ["dashboard", "overview"],
    queryFn: getDashboardOverview,
    staleTime: 15000,
  });
}

export function useDashboardProperties() {
  return useQuery({
    queryKey: ["dashboard", "properties"],
    queryFn: getDashboardProperties,
    staleTime: 60000,
  });
}