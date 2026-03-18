import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const navigate = useNavigate();

  async function loadProperties() {
    setLoading(true);
    setErr(null);

    try {
      const res = await fetch(`${API_BASE}/api/dashboard/properties`, {
        credentials: "include",
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }

      const data: PropertiesResp = await res.json();
      setItems(data.items ?? []);
    } catch (e: any) {
      console.error("PROPERTIES ERROR", e);
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProperties();
  }, []);

  async function handleArchive(propertyId: string) {
    const ok = window.confirm(
      "Are you sure you want to archive this property?"
    );
    if (!ok) return;

    setArchivingId(propertyId);
    setErr(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/dashboard/properties/${propertyId}/archive`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }

      await loadProperties();
    } catch (e: any) {
      console.error("ARCHIVE PROPERTY ERROR", e);
      setErr(String(e?.message ?? e));
    } finally {
      setArchivingId(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
            Properties
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
            Manage all your properties from one place.
          </div>
        </div>

        <button
          onClick={() => navigate("/onboarding/property")}
          style={{
            height: 44,
            padding: "0 16px",
            borderRadius: 12,
            border: "none",
            background: "#2563eb",
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Add Property
        </button>
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
            display: "grid",
            gap: 12,
          }}
        >
          <div>No properties found yet.</div>

          <button
            onClick={() => navigate("/onboarding/property")}
            style={{
              height: 42,
              padding: "0 14px",
              borderRadius: 12,
              border: "none",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              width: "fit-content",
            }}
          >
            Create First Property
          </button>
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
            <button
              key={p.id}
              onClick={() => navigate(`/properties/${p.id}`)}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 18,
                padding: 18,
                background: "#fff",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                display: "grid",
                gap: 14,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Property Control Node
                  </div>
                </div>

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

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/properties/${p.id}/edit`);
                  }}
                  style={{
                    height: 38,
                    padding: "0 14px",
                    borderRadius: 10,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleArchive(p.id);
                  }}
                  disabled={archivingId === p.id}
                  style={{
                    height: 38,
                    padding: "0 14px",
                    borderRadius: 10,
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#b91c1c",
                    fontWeight: 700,
                    cursor: "pointer",
                    opacity: archivingId === p.id ? 0.7 : 1,
                  }}
                >
                  {archivingId === p.id ? "Archiving..." : "Archive"}
                </button>
              </div>
            </button>
          ))}
        </div>
      )}

      <div style={{ color: "#666", fontSize: 13 }}>
        {loading ? "Loading..." : `${items.length} properties`}
      </div>
    </div>
  );
}