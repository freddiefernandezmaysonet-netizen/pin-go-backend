const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type PropertyRow = {
  id: string;
  name: string;
  locks: number;
  activeReservations: number;
  pms: string;
  status: string;
  address1?: string;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
  latitude?: number | null;
  longitude?: number | null;
  checkInTime?: "15:00" | "16:00";
  cleaningStartOffsetMinutes?: number;
};

export type PropertiesResp = {
  items: PropertyRow[];
};

export type CreatePropertyInput = {
  name: string;
  address1?: string;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
  latitude?: number | null;
  longitude?: number | null;
  checkInTime: "15:00" | "16:00";
  cleaningStartOffsetMinutes?: number;
};

export type UpdatePropertyInput = {
  name?: string;
  address1?: string;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
  latitude?: number | null;
  longitude?: number | null;
  checkInTime?: "15:00" | "16:00";
  cleaningStartOffsetMinutes?: number;
};

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || "Request failed");
  }
  return data;
}

export async function fetchProperties(): Promise<PropertiesResp> {
  const res = await fetch(`${API_BASE}/api/properties`, {
    credentials: "include",
  });
  return readJson(res);
}

export async function createProperty(input: CreatePropertyInput) {
  const res = await fetch(`${API_BASE}/api/properties`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  return readJson(res);
}

export async function updateProperty(id: string, input: UpdatePropertyInput) {
  const res = await fetch(`${API_BASE}/api/properties/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  return readJson(res);
}

export async function archiveProperty(id: string) {
  const res = await fetch(`${API_BASE}/api/properties/${id}/archive`, {
    method: "POST",
    credentials: "include",
  });

  return readJson(res);
}