import { useEffect, useState } from "react";

type PropertyRow = {
  id: string;
  name: string;
  locks: number;
  activeReservations: number;
  pms: string;
  status: string;
};

type PropertiesResp = {
  items: PropertyRow[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        border: "1px solid #f3f4f6",
        borderRadius: 12,
        padding: 12,
        background: "#fafafa",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
        {value}
      </div>
    </div>
  );
}

export function PropertiesPage() {
  const [items, setItems] = useState<PropertyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    fetch(`${API_BASE}/api/dashboard/properties`)
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
        return res.json();
      })
      .then((data: PropertiesResp) => {
        setItems(data.items ?? []);
      })
      .catch((e) => {
        console.error("PROPERTIES ERROR", e);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Properties</h1>
        <p style={{ color: "#666", marginTop: 8 }}>
          Operational summary by property.
        </p>
      </div>

      {err ? (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            padding: 12,
            borderRadius: 12,
            color: "#991b1b",
          }}
        >
          <b>Error:</b> {err}
        </div>
      ) : null}

      {loading ? (
        <div style={{ color: "#666" }}>Loading...</div>
      ) : items.length === 0 ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: 16,
            color: "#666",
            background: "#fff",
          }}
        >
          No properties found.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          }}
        >
          {items.map((p) => (
            <div
              key={p.id}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 18,
                padding: 18,
                background: "#fff",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                display: "grid",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Property Control Node
                  </div>
                </div>

                <div>
                  <span
                    style={{
                      fontSize: 12,
                      padding: "4px 8px",
                      borderRadius: 999,
                      border: "1px solid #e5e7eb",
                      background: "#ecfdf5",
                      color: "#065f46",
                    }}
                  >
                    {p.status}
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                }}
              >
                <Metric label="Locks" value={p.locks} />
                <Metric label="Active Reservations" value={p.activeReservations} />
                <Metric label="PMS" value={String(p.pms).toUpperCase()} />
                <Metric label="Property" value="ONLINE" />
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ color: "#666", fontSize: 13 }}>
        {loading ? "Loading..." : `${items.length} properties`}
      </div>
    </div>
  );
}