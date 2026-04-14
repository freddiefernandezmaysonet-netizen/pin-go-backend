const BASE_URL = process.env.LODGIFY_API_BASE_URL || "https://api.lodgify.com";
const API_KEY = process.env.LODGIFY_API_KEY || "";

export async function lodgifyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-ApiKey": API_KEY,
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[lodgify] ${res.status} ${res.statusText} ${text}`);
  }

  return res.json() as Promise<T>;
}