const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type HealthSummary = {
  healthy: number;
  warning: number;
  critical: number;
  unknown: number;
  openAlerts: number;
};

export type HealthSummaryResp = {
  ok: boolean;
  summary: HealthSummary;
};

export type HealthLockRow = {
  id: string;
  name: string;
  property?: {
    id: string;
    name: string;
  } | null;
  battery: number | null;
  isOnline: boolean | null;
  gatewayConnected: boolean | null;
  lastSeenAt: string | null;
  healthStatus: string;
};

export type HealthLocksResp = {
  ok: boolean;
  items: HealthLockRow[];
};

export async function fetchHealthSummary(): Promise<HealthSummaryResp> {
  const res = await fetch(`${API_BASE}/api/dashboard/health/summary`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch health summary");
  }

  return res.json();
}

export async function fetchHealthLocks(): Promise<HealthLocksResp> {
  const res = await fetch(`${API_BASE}/api/dashboard/health/locks`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch health locks");
  }

  return res.json();
}