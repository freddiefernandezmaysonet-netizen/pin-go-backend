import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

type ReservationStatus = "ACTIVE" | "CANCELLED";
type OperationalStatus = "UPCOMING" | "IN_HOUSE" | "CHECKED_OUT" | "CANCELLED";

type ReservationRow = {
  id: string;
  guestName: string;
  guestEmail?: string | null;
  roomName?: string | null;
  checkIn: string;
  checkOut: string;
  status: ReservationStatus;
  operationalStatus: OperationalStatus;
  source?: string | null;
  externalProvider?: string | null;
  property?: { id: string; name: string } | null;
  propertyId?: string | null;
};

type ReservationsResp = {
  page: number;
  pageSize: number;
  total: number;
  items: ReservationRow[];
};

type PropertiesResp = { items: Array<{ id: string; name: string }> };

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${t || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function fmt(d: string) {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}

function statusStyles(status: OperationalStatus) {
  if (status === "IN_HOUSE") {
    return {
      background: "#ecfdf5",
      color: "#065f46",
      border: "1px solid #a7f3d0",
    };
  }
  if (status === "UPCOMING") {
    return {
      background: "#eff6ff",
      color: "#1d4ed8",
      border: "1px solid #bfdbfe",
    };
  }
  if (status === "CHECKED_OUT") {
    return {
      background: "#f3f4f6",
      color: "#4b5563",
      border: "1px solid #e5e7eb",
    };
  }
  return {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
  };
}

function sourceLabel(r: ReservationRow) {
  return r.externalProvider ?? r.source ?? "—";
}

function propertyLabel(r: ReservationRow) {
  return r.property?.name ?? r.propertyId ?? "—";
}

export function ReservationsPage() {
  const navigate = useNavigate();

  const [properties, setProperties] = useState<PropertiesResp["items"]>([]);
  const [propertyId, setPropertyId] = useState<string>("ALL");
  const [status, setStatus] = useState<string>("ALL");
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(10);

  const [data, setData] = useState<ReservationsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<PropertiesResp>("/api/dashboard/properties")
      .then((r) => setProperties(r.items ?? []))
      .catch(() => setProperties([]));
  }, []);

  const qs = useMemo(() => {
    const q = new URLSearchParams();
    q.set("page", String(page));
    q.set("pageSize", String(pageSize));
    if (propertyId !== "ALL") q.set("propertyId", propertyId);
    return q.toString();
  }, [page, pageSize, propertyId]);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    api<ReservationsResp>(`/api/dashboard/reservations?${qs}`)
      .then((r) => setData(r))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [qs]);

  const filteredItems =
    status === "ALL"
      ? (data?.items ?? [])
      : (data?.items ?? []).filter((r) => r.operationalStatus === status);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 12,
          background: "#fff",
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>Property</div>
          <select
            value={propertyId}
            onChange={(e) => {
              setPage(1);
              setPropertyId(e.target.value);
            }}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: "#fff",
            }}
          >
            <option value="ALL">All</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>Operational Status</div>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: "#fff",
            }}
          >
            <option value="ALL">All</option>
            <option value="UPCOMING">UPCOMING</option>
            <option value="IN_HOUSE">IN_HOUSE</option>
            <option value="CHECKED_OUT">CHECKED_OUT</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>
        </div>

        <div style={{ marginLeft: "auto", color: "#666", fontSize: 13 }}>
          {loading ? "Loading…" : data ? `${filteredItems.length} shown / ${data.total} total` : "—"}
        </div>
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

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          overflow: "hidden",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "#f9fafb" }}>
              <tr>
                {["Guest", "Property", "Check-in", "Check-out", "Operational", "Source"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      fontSize: 12,
                      color: "#666",
                      padding: 12,
                      borderBottom: "1px solid #e5e7eb",
                      whiteSpace: "nowrap",
                      fontWeight: 700,
                      letterSpacing: 0.2,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "#666" }}>
                    Loading…
                  </td>
                </tr>
              ) : filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "#666" }}>
                    No reservations found for this filter.
                  </td>
                </tr>
              ) : (
                filteredItems.map((r) => {
                  const styles = statusStyles(r.operationalStatus);

                  return (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/reservations/${r.id}`)}
                      style={{
                        borderBottom: "1px solid #f3f4f6",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#f9fafb";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#fff";
                      }}
                    >
                      <td style={{ padding: 12 }}>
                        <div style={{ fontWeight: 700, color: "#111827" }}>{r.guestName}</div>
                        <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
                          {r.roomName ?? r.guestEmail ?? ""}
                        </div>
                      </td>

                      <td style={{ padding: 12 }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{propertyLabel(r)}</div>
                      </td>

                      <td style={{ padding: 12, color: "#333", whiteSpace: "nowrap" }}>{fmt(r.checkIn)}</td>

                      <td style={{ padding: 12, color: "#333", whiteSpace: "nowrap" }}>{fmt(r.checkOut)}</td>

                      <td style={{ padding: 12 }}>
                        <span
                          style={{
                            fontSize: 12,
                            padding: "5px 10px",
                            borderRadius: 999,
                            background: styles.background,
                            color: styles.color,
                            border: styles.border,
                            fontWeight: 700,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {r.operationalStatus}
                        </span>
                      </td>

                      <td style={{ padding: 12, color: "#666" }}>{sourceLabel(r)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: 12,
            borderTop: "1px solid #f3f4f6",
            background: "#fff",
          }}
        >
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: page <= 1 ? "#f9fafb" : "#fff",
              cursor: page <= 1 ? "not-allowed" : "pointer",
              color: "#111827",
              fontWeight: 600,
            }}
          >
            Prev
          </button>

          <div style={{ color: "#666", fontSize: 13 }}>
            Page <b>{page}</b> / {totalPages}
          </div>

          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: page >= totalPages ? "#f9fafb" : "#fff",
              cursor: page >= totalPages ? "not-allowed" : "pointer",
              color: "#111827",
              fontWeight: 600,
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}