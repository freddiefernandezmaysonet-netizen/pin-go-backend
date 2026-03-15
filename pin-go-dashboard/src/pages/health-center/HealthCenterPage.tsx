import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchHealthSummary,
  fetchHealthLocks,
  type HealthSummary,
  type HealthLockRow,
} from "../../services/health";

function Stat({
  label,
  value,
  helper,
}: {
  label: string;
  value: string | number;
  helper?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: 18,
        background: "#fff",
        minHeight: 110,
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
        {value}
      </div>
      {helper ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          {helper}
        </div>
      ) : null}
    </div>
  );
}

function SectionCard({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 18,
        padding: 18,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>{title}</h3>
        {right}
      </div>

      {children}
    </div>
  );
}

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return {
    height: 40,
    padding: "0 16px",
    borderRadius: 10,
    border: "1px solid #111827",
    background: disabled ? "#e5e7eb" : "#111827",
    color: disabled ? "#6b7280" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
  };
}

function healthBadgeStyle(status: string): React.CSSProperties {
  let background = "#f3f4f6";
  let color = "#374151";
  let border = "1px solid #e5e7eb";

  if (status === "HEALTHY") {
    background = "#ecfdf5";
    color = "#166534";
    border = "1px solid #bbf7d0";
  }

  if (status === "LOW_BATTERY") {
    background = "#fffbeb";
    color = "#92400e";
    border = "1px solid #fde68a";
  }

  if (status === "CRITICAL" || status === "OFFLINE") {
    background = "#fef2f2";
    color = "#991b1b";
    border = "1px solid #fecaca";
  }

  if (status === "GATEWAY_DISCONNECTED") {
    background = "#eff6ff";
    color = "#1d4ed8";
    border = "1px solid #bfdbfe";
  }

  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 120,
    height: 30,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    background,
    color,
    border,
  };
}

function formatLastSeen(value?: string | null) {
  if (!value) return "—";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleString();
}

type ClickableRowProps = {
  lock: HealthLockRow;
  onClick: () => void;
};

function ClickableRow({ lock, onClick }: ClickableRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: "pointer",
        background: hovered ? "#f9fafb" : "#fff",
        transition: "background 120ms ease",
      }}
    >
      <td style={tdStyle}>
        <div style={{ fontWeight: 600, color: "#111827" }}>{lock.name}</div>
      </td>

      <td style={tdStyle}>{lock.property?.name ?? "—"}</td>

      <td style={tdStyle}>
        {lock.battery == null ? "—" : `${lock.battery}%`}
      </td>

      <td style={tdStyle}>
        {lock.isOnline == null
          ? "—"
          : lock.isOnline
          ? "ONLINE"
          : "OFFLINE"}
      </td>

      <td style={tdStyle}>
        {lock.gatewayConnected == null
          ? "—"
          : lock.gatewayConnected
          ? "CONNECTED"
          : "DISCONNECTED"}
      </td>

      <td style={tdStyle}>{formatLastSeen(lock.lastSeenAt)}</td>

      <td style={tdStyle}>
        <span style={healthBadgeStyle(lock.healthStatus)}>
          {lock.healthStatus}
        </span>
      </td>
    </tr>
  );
}

export function HealthCenterPage() {
  const navigate = useNavigate();

  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [locks, setLocks] = useState<HealthLockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [summaryResp, locksResp] = await Promise.all([
        fetchHealthSummary(),
        fetchHealthLocks(),
      ]);

      setSummary(summaryResp.summary);
      setLocks(locksResp.items ?? []);
    } catch (err: any) {
      console.error("Health Center load failed", err);
      setError(String(err?.message ?? err ?? "Failed to load Health Center."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Link to="/overview">← Back to overview</Link>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 8 }}>
          Health Center
        </h1>
        <p style={{ color: "#666", margin: 0 }}>
          Monitor device health, connectivity and active operational status
          across active locks.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <Stat
          label="Healthy"
          value={summary?.healthy ?? 0}
          helper="Active locks currently counted as healthy"
        />
        <Stat
          label="Warnings"
          value={summary?.warning ?? 0}
          helper="Locks needing review soon"
        />
        <Stat
          label="Critical"
          value={summary?.critical ?? 0}
          helper="Locks requiring immediate attention"
        />
        <Stat
          label="Open Alerts"
          value={summary?.openAlerts ?? 0}
          helper="Current alert load across active locks"
        />
      </div>

      <SectionCard
        title="Active Locks Health"
        right={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={buttonStyle(loading)}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          {error ? (
            <div
              style={{
                borderRadius: 10,
                padding: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          ) : null}

          <div
            style={{
              overflowX: "auto",
              border: "1px solid #f3f4f6",
              borderRadius: 14,
              background: "#fff",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 980,
              }}
            >
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                  <th style={thStyle}>Lock</th>
                  <th style={thStyle}>Property</th>
                  <th style={thStyle}>Battery</th>
                  <th style={thStyle}>Online</th>
                  <th style={thStyle}>Gateway</th>
                  <th style={thStyle}>Last Seen</th>
                  <th style={thStyle}>Health</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td style={emptyTdStyle} colSpan={7}>
                      Loading health data...
                    </td>
                  </tr>
                ) : locks.length === 0 ? (
                  <tr>
                    <td style={emptyTdStyle} colSpan={7}>
                      No active locks found.
                    </td>
                  </tr>
                ) : (
                  locks.map((lock) => (
                    <ClickableRow
                      key={lock.id}
                      lock={lock}
                      onClick={() => navigate(`/locks/${lock.id}`)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Operational Notes">
        <p style={{ color: "#6b7280", margin: 0 }}>
          This first version of Health Center is showing active locks only.
          Next step: connect live device health, battery freshness, gateway
          status and dashboard alerts for a fully operational monitoring view.
        </p>
      </SectionCard>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "12px 14px",
  fontSize: 13,
  color: "#6b7280",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "14px",
  fontSize: 14,
  color: "#111827",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
};

const emptyTdStyle: React.CSSProperties = {
  padding: "22px 14px",
  textAlign: "center",
  color: "#6b7280",
  fontSize: 14,
};