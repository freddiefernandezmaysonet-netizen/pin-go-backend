import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export function useRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource(`${BASE}/api/events`, {
      withCredentials: true,
    });

    es.addEventListener("reservation-created", () => {
      qc.invalidateQueries({ queryKey: ["reservations"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    });

    return () => {
      es.close();
    };
  }, [qc]);
}