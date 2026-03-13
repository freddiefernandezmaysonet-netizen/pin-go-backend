import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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

type TtlockStatusResp = {
  ok: boolean;
  connected: boolean;
  uid?: number | string;
  error?: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function badgeStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    background: active ? "#ecfdf5" : "#fef2f2",
    color: active ? "#065f46" : "#991b1b",
    fontWeight: 700,
  };
}

export function LocksPage() {
  const navigate = useNavigate();

  const [data, setData] = useState<LocksResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [ttlockStatus, setTtlockStatus] = useState<TtlockStatusResp | null>(null);
  const [ttlockStatusLoading, setTtlockStatusLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=20`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
        return res.json();
      })
      .then((resp: LocksResp) => {
        setData(resp);
      })
      .catch((e) => {
        console.error("LOCKS ERROR", e);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setTtlockStatusLoading(true);

    fetch(`${API_BASE}/api/org/ttlock/status`, {
      credentials: "include",
    })
      .then(async (res) => {
        const json = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(json?.error || `API ${res.status}`);
        }

        setTtlockStatus(json as TtlockStatusResp);
      })
      .catch((e) => {
        console.error("TTLOCK STATUS ERROR", e);
        setTtlockStatus(null);
      })
      .finally(() => setTtlockStatusLoading(false));
  }, []);

  const items = data?.items ?? [];

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
            Locks
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
            Monitor active locks and open each lock detail to manage swap and status.
          </div>
        </div>
      </div>

      {ttlockStatusLoading ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            background: "#fff",
            padding: 14,
            color: "#6b7280",
            fontSize: 14,
          }}
        >
          Checking TTLock connection...
        </div>
      ) : ttlockStatus?.connected ? (
        <div
          style={{
            border: "1px solid #bbf7d0",
            borderRadius: 14,
            background: "#f0fdf4",
            padding: 14,
            color: "#166534",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 700 }}>TTLock connected</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {ttlockStatus.uid ? `UID: ${ttlockStatus.uid}` : "Connection active"}
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate("/integrations/ttlock")}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #bbf7d0",
              background: "#ffffff",
              color: "#166534",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Review Connection
          </button>
        </div>
      ) : (
        <div
          style={{
            border: "1px solid #fde68a",
            borderRadius: 14,
            background: "#fffbeb",
            padding: 14,
            color: "#92400e",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 700 }}>TTLock not connected</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Connect TTLock to import locks and automate access from Pin&Go.
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate("/integrations/ttlock")}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #111827",
              background: "#111827",
              color: "#ffffff",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Connect TTLock
          </button>
        </div>
      )}

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
        <div style={{ color: "#666" }}>Loading locks...</div>
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
          No locks found yet.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>Lock</th>
                <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>TTLock ID</th>
                <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>Property</th>
                <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>Status</th>
                <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>Battery</th>
              </tr>
            </thead>

            <tbody>
              {items.map((lock) => (
                <tr
                  key={lock.id}
                  onClick={() => navigate(`/locks/${lock.id}`)}
                  style={{
                    cursor: "pointer",
                    borderBottom: "1px solid #f3f4f6",
                  }}
                >
                  <td style={{ padding: 14 }}>
                    <div style={{ fontWeight: 600, color: "#111827" }}>
                      {lock.name ?? "TTLock Lock"}
                    </div>
                  </td>

                  <td
                    style={{
                      padding: 14,
                      color: "#6b7280",
                      fontFamily: "monospace",
                      fontSize: 13,
                    }}
                  >
                    {lock.ttlockLockId}
                  </td>

                  <td style={{ padding: 14, color: "#374151" }}>
                    {lock.property?.name ?? "—"}
                  </td>

                  <td style={{ padding: 14 }}>
                    <span style={badgeStyle(lock.isActive)}>
                      {lock.isActive ? "ACTIVE" : "DISABLED"}
                    </span>
                  </td>

                  <td style={{ padding: 14, color: "#374151" }}>
                    {lock.battery ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ color: "#666", fontSize: 13 }}>
        {loading ? "Loading..." : `${items.length} locks`}
      </div>
    </div>
  );
}