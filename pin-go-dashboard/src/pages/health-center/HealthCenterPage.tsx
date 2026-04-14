import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type HealthSummary = {
  healthy: number;
  warning: number;
  atRisk: number;
  critical: number;
  unknown: number;
  openAlerts: number;
};

type HealthLockRow = {
  id: string;
  name: string;
  property: { id: string; name: string } | null;

  battery: number | null;
  isOnline: boolean | null;
  gatewayConnected: boolean | null;

  healthStatus: string;
  healthMessage: string | null;

  operationalRisk: string;
  operationalMessage: string | null;
  recommendedAction: string | null;

  nextCheckInAt: string | null;
  hasActiveAccess: boolean;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  riskCalculatedAt: string | null;

  updatedAt: string;
};

type ControlTowerRow = {
  id: string;
  name: string;
  property: { id: string; name: string } | null;
  battery: number | null;
  gatewayConnected: boolean | null;
  operationalRisk: string;
  operationalMessage: string | null;
  recommendedAction: string | null;
  nextCheckInAt: string | null;
  updatedAt: string;
};

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
}: {
  title: string;
  children: React.ReactNode;
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
      </div>

      {children}
    </div>
  );
}

function riskBadgeStyle(risk: string): React.CSSProperties {
  let background = "#f3f4f6";
  let color = "#374151";
  let border = "1px solid #e5e7eb";

  if (risk === "HEALTHY") {
    background = "#ecfdf5";
    color = "#166534";
    border = "1px solid #bbf7d0";
  }

  if (risk === "WARNING") {
    background = "#fffbeb";
    color = "#92400e";
    border = "1px solid #fde68a";
  }

  if (risk === "AT_RISK") {
    background = "#fff7ed";
    color = "#c2410c";
    border = "1px solid #fdba74";
  }

  if (risk === "CRITICAL") {
    background = "#fef2f2";
    color = "#991b1b";
    border = "1px solid #fecaca";
  }

  if (risk === "UNKNOWN") {
    background = "#f3f4f6";
    color = "#4b5563";
    border = "1px solid #d1d5db";
  }

  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 110,
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

function formatDateTime(value?: string | null) {
  if (!value) return "—";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleString();
}

function formatBattery(value?: number | null) {
  if (value == null) return "—";
  return `${value}%`;
}

function formatGateway(value?: boolean | null) {
  if (value == null) return "—";
  return value ? "CONNECTED" : "DISCONNECTED";
}

function TowerRow({ item }: { item: ControlTowerRow }) {
  return (
    <div
      style={{
        border: "1px solid #f3f4f6",
        borderRadius: 14,
        padding: 14,
        display: "grid",
        gap: 10,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 700, color: "#111827" }}>{item.name}</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
            {item.property?.name ?? "—"}
          </div>
        </div>

        <span style={riskBadgeStyle(item.operationalRisk)}>
          {item.operationalRisk}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        <div style={towerMetaStyle}>
          <strong>Battery:</strong> {formatBattery(item.battery)}
        </div>
        <div style={towerMetaStyle}>
          <strong>Gateway:</strong> {formatGateway(item.gatewayConnected)}
        </div>
        <div style={towerMetaStyle}>
          <strong>Next Check-in:</strong> {formatDateTime(item.nextCheckInAt)}
        </div>
      </div>

      <div style={{ fontSize: 14, color: "#111827" }}>
        {item.operationalMessage ?? "No operational message available."}
      </div>

      <div
        style={{
          fontSize: 13,
          color: "#92400e",
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 10,
          padding: 10,
        }}
      >
        <strong>Recommended Action:</strong>{" "}
        {item.recommendedAction ?? "Review this lock."}
      </div>
    </div>
  );
}

function HealthTableRow({ lock }: { lock: HealthLockRow }) {
  return (
    <tr>
      <td style={tdStyle}>
        <div style={{ fontWeight: 600, color: "#111827" }}>{lock.name}</div>
      </td>

      <td style={tdStyle}>{lock.property?.name ?? "—"}</td>

      <td style={tdStyle}>{formatBattery(lock.battery)}</td>

      <td style={tdStyle}>{formatGateway(lock.gatewayConnected)}</td>

      <td style={tdStyle}>{formatDateTime(lock.nextCheckInAt)}</td>

      <td style={tdStyle}>
        <span style={riskBadgeStyle(lock.operationalRisk)}>
          {lock.operationalRisk}
        </span>
      </td>

      <td style={tdStyle}>
        {lock.recommendedAction ?? lock.operationalMessage ?? "—"}
      </td>
    </tr>
  );
}

export function HealthCenterPage() {
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [locks, setLocks] = useState<HealthLockRow[]>([]);
  const [controlTower, setControlTower] = useState<ControlTowerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [summaryResp, locksResp, towerResp] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/health/summary`, {
          credentials: "include",
        }),
        fetch(`${API_BASE}/api/dashboard/health/locks`, {
          credentials: "include",
        }),
        fetch(`${API_BASE}/api/dashboard/health/control-tower`, {
          credentials: "include",
        }),
      ]);

      if (!summaryResp.ok) {
        throw new Error("Failed to load health summary");
      }

      if (!locksResp.ok) {
        throw new Error("Failed to load health locks");
      }

      if (!towerResp.ok) {
        throw new Error("Failed to load health control tower");
      }

      const summaryData = await summaryResp.json();
      const locksData = await locksResp.json();
      const towerData = await towerResp.json();

      setSummary(summaryData.summary ?? null);
      setLocks(locksData.items ?? []);
      setControlTower(towerData.items ?? []);
    } catch (err: any) {
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
          Show only locks that require attention before operations are affected.
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
          helper="Locks operating normally"
        />
        <Stat
          label="Warning"
          value={summary?.warning ?? 0}
          helper="Preventive attention required"
        />
        <Stat
          label="At Risk"
          value={summary?.atRisk ?? 0}
          helper="Operational issue may impact upcoming stays"
        />
        <Stat
          label="Critical"
          value={summary?.critical ?? 0}
          helper="Immediate action required"
        />
        <Stat
          label="Unknown"
          value={summary?.unknown ?? 0}
          helper="Missing or stale telemetry"
        />
      </div>

      {error ? (
        <div
          style={{
            borderRadius: 12,
            padding: 14,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      ) : null}

      <SectionCard title="Control Tower">
        {loading ? (
          <div style={emptyBlockStyle}>Loading control tower...</div>
        ) : controlTower.length === 0 ? (
          <div style={emptyBlockStyle}>
            No locks require immediate operational attention.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {controlTower.map((item) => (
              <TowerRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Locks Requiring Attention">
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
                <th style={thStyle}>Gateway</th>
                <th style={thStyle}>Next Check-in</th>
                <th style={thStyle}>Risk</th>
                <th style={thStyle}>Recommended Action</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td style={emptyTdStyle} colSpan={7}>
                    Loading locks requiring attention...
                  </td>
                </tr>
              ) : locks.length === 0 ? (
                <tr>
                  <td style={emptyTdStyle} colSpan={7}>
                    No locks currently require attention.
                  </td>
                </tr>
              ) : (
                locks.map((lock) => (
                  <HealthTableRow key={lock.id} lock={lock} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Operational Notes">
        <p style={{ color: "#6b7280", margin: 0 }}>
          Health Center is an operational work queue. Healthy locks are counted
          in summary only and are intentionally excluded from the control tower
          and main table.
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

const emptyBlockStyle: React.CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#f9fafb",
  border: "1px solid #f3f4f6",
  color: "#6b7280",
  fontSize: 14,
};

const towerMetaStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#374151",
};