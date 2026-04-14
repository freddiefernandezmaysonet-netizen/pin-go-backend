import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

type LockRow = {
  id: string;
  ttlockLockId: number;
  name: string | null;
  isActive: boolean;
  property: { id: string; name: string } | null;
  battery?: number | null;
};

type LocksResp = {
  page: number;
  pageSize: number;
  total: number;
  items: LockRow[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export function LocksPage() {
  const [data, setData] = useState<LocksResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [propertyFilter, setPropertyFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  useEffect(() => {
    setLoading(true);
    setErr(null);

    fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=20`)
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
        return res.json();
      })
      .then((r: LocksResp) => {
        console.log("LOCKS DATA", r);
        setData(r);
      })
      .catch((e) => {
        console.error("LOCKS ERROR", e);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  const propertyOptions = useMemo(() => {
    const map = new Map<string, string>();

    for (const lock of data?.items ?? []) {
      if (lock.property?.id && lock.property?.name) {
        map.set(lock.property.id, lock.property.name);
      }
    }

    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];

    return items.filter((lock) => {
      const matchesProperty =
        propertyFilter === "ALL" ? true : lock.property?.id === propertyFilter;

      const status = lock.isActive ? "ACTIVE" : "DISABLED";
      const matchesStatus =
        statusFilter === "ALL" ? true : status === statusFilter;

      return matchesProperty && matchesStatus;
    });
  }, [data, propertyFilter, statusFilter]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Locks</h1>
        <p style={{ color: "#666" }}>TTLock devices connected to Pin&Go.</p>
      </div>

      {err ? (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            padding: 12,
            borderRadius: 12,
          }}
        >
          <b>Error:</b> {err}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <select
          value={propertyFilter}
          onChange={(e) => setPropertyFilter(e.target.value)}
          style={{
            height: 40,
            minWidth: 220,
            borderRadius: 10,
            border: "1px solid #d1d5db",
            padding: "0 12px",
            background: "#fff",
          }}
        >
          <option value="ALL">All Properties</option>
          {propertyOptions.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            height: 40,
            minWidth: 180,
            borderRadius: 10,
            border: "1px solid #d1d5db",
            padding: "0 12px",
            background: "#fff",
          }}
        >
          <option value="ALL">All Status</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="DISABLED">DISABLED</option>
        </select>
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: "#f9fafb" }}>
            <tr>
              {["Lock", "Property", "TTLock ID", "Status", "Battery"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    fontSize: 12,
                    color: "#666",
                    padding: 12,
                    borderBottom: "1px solid #e5e7eb",
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
                <td colSpan={5} style={{ padding: 16, color: "#666" }}>
                  Loading…
                </td>
              </tr>
            ) : err ? (
              <tr>
                <td colSpan={5} style={{ padding: 16, color: "#991b1b" }}>
                  Failed to load locks.
                </td>
              </tr>
            ) : !data || filteredItems.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 16, color: "#666" }}>
                  No locks found.
                </td>
              </tr>
            ) : (
              filteredItems.map((l) => (
                <tr key={l.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: 12, fontWeight: 600 }}>
                    <Link
                      to={`/locks/${l.id}`}
                      style={{
                        color: "#111827",
                        textDecoration: "underline",
                        textUnderlineOffset: 3,
                      }}
                    >
                      {l.name ?? "TTLock Lock"}
                    </Link>
                  </td>
                  <td style={{ padding: 12 }}>{l.property?.name ?? "—"}</td>
                  <td style={{ padding: 12 }}>{l.ttlockLockId}</td>
                  <td style={{ padding: 12 }}>
                    <span
                      style={{
                        fontSize: 12,
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: "1px solid #e5e7eb",
                        background: l.isActive ? "#ecfdf5" : "#fef2f2",
                        color: l.isActive ? "#065f46" : "#991b1b",
                      }}
                    >
                      {l.isActive ? "ACTIVE" : "DISABLED"}
                    </span>
                  </td>
                  <td style={{ padding: 12 }}>
                    {l.battery == null ? "—" : `${l.battery}%`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ color: "#666", fontSize: 13 }}>
        {loading
          ? "Loading…"
          : data
          ? `${filteredItems.length} of ${data.total} locks`
          : "—"}
      </div>
    </div>
  );
}