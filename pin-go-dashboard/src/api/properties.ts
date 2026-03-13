const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type PropertyRow = {
  id: string;
  name: string;
  locks: number;
  activeReservations: number;
  pms: string;
  status: string;
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
  checkInTime: "15:00" | "16:00";
  cleaningStartOffsetMinutes?: number;
};

export async function fetchProperties(): Promise<PropertiesResp> {
  const res = await fetch(`${API_BASE}/api/dashboard/properties`, {
    credentials: "include",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || "Failed to fetch properties");
  }

  return res.json();
}

export async function createProperty(input: CreatePropertyInput) {
  const res = await fetch(`${API_BASE}/api/properties`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    let error = "Failed to create property";

    try {
      const data = await res.json();
      error = data?.error || error;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) error = text;
    }

    throw new Error(error);
  }

  return res.json();
}