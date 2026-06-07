const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type DashboardOrganization = {
  id: string;
  name: string;
  slug: string | null;
  publicBookingEnabled: boolean;
  updatedAt: string;
};

export type UpdateDashboardOrganizationInput = {
  name?: string;
  slug?: string;
  publicBookingEnabled?: boolean;
};

export async function getDashboardOrganization() {
  const res = await fetch(`${API_BASE}/api/dashboard/organization`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to load organization");
  }

  const data = await res.json();
  return data.organization as DashboardOrganization;
}

export async function updateDashboardOrganization(
  input: UpdateDashboardOrganizationInput
) {
  const res = await fetch(`${API_BASE}/api/dashboard/organization`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to update organization");
  }

  const data = await res.json();
  return data.organization as DashboardOrganization;
}