const API_BASE =
  import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type HealthSummary = {
  healthy: number;
  warning: number;
  atRisk: number;
  critical: number;
  unknown: number;
  openAlerts: number;
};

export type HealthLockRow = {
  id: string;
  name: string;
  property: { id: string; name: string } | null;

  battery: number | null;
  isOnline: boolean | null;
  gatewayConnected: boolean | null;

  healthStatus: string;
  healthMessage: string | null;

  operationalRisk: string;
  operationalMessage: string | null;
  recommendedAction: string | null;

  nextCheckInAt: string | null;
  hasActiveAccess: boolean;

  lastSeenAt: string | null;
  lastSyncAt: string | null;
  riskCalculatedAt: string | null;

  updatedAt: string;
};

export type ControlTowerRow = {
  id: string;
  name: string;
  property: { id: string; name: string } | null;

  battery: number | null;
  gatewayConnected: boolean | null;

  operationalRisk: string;
  operationalMessage: string | null;
  recommendedAction: string | null;

  nextCheckInAt: string | null;

  updatedAt: string;
};

export async function fetchHealthSummary(): Promise<{
  summary: HealthSummary;
}> {
  const res = await fetch(
    `${API_BASE}/api/dashboard/health/summary`,
    {
      credentials: "include",
    }
  );

  if (!res.ok) {
    throw new Error("Failed to load health summary");
  }

  return res.json();
}

export async function fetchHealthLocks(): Promise<{
  items: HealthLockRow[];
}> {
  const res = await fetch(
    `${API_BASE}/api/dashboard/health/locks`,
    {
      credentials: "include",
    }
  );

  if (!res.ok) {
    throw new Error("Failed to load health locks");
  }

  return res.json();
}

export async function fetchControlTower(): Promise<{
  items: ControlTowerRow[];
}> {
  const res = await fetch(
    `${API_BASE}/api/dashboard/health/control-tower`,
    {
      credentials: "include",
    }
  );

  if (!res.ok) {
    throw new Error("Failed to load control tower");
  }

  return res.json();
}