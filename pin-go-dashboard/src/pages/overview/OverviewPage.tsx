import { useEffect, useState } from "react";

type MetricsResp = {
  upcomingArrivals: number;
  inHouse: number;
  checkoutsToday: number;
  activeLocks: number;
  properties: number;
  updatedAt: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function MetricCard({
  title,
  value,
  accent,
}: {
  title: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 18,
        padding: 20,
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          width: 42,
          height: 6,
          borderRadius: 999,
          background: accent,
          marginBottom: 14,
        }}
      />
      <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 10 }}>
        {title}
      </div>
      <div
        style={{
          fontSize: 34,
          fontWeight: 700,
          lineHeight: 1.1,
          color: "#111827",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<MetricsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    fetch(`${API_BASE}/api/dashboard/metrics`)
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
        return res.json();
      })
      .then((r: MetricsResp) => {
        setData(r);
      })
      .catch((e) => {
        console.error("OVERVIEW METRICS ERROR", e);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  if (err) {
    return (
      <div
        style={{
          border: "1px solid #fecaca",
          background: "#fef2f2",
          padding: 16,
          borderRadius: 16,
          color: "#991b1b",
        }}
      >
        Error: {err}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1
          style={{
            fontSize: 30,
            fontWeight: 700,
            margin: 0,
            color: "#111827",
          }}
        >
          Overview
        </h1>
        <p style={{ color: "#6b7280", marginTop: 8 }}>
          Live operational metrics from Pin&Go backend.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        }}
      >
        <MetricCard
          title="Upcoming Arrivals"
          value={loading ? "..." : (data?.upcomingArrivals ?? 0)}
          accent="#2563eb"
        />
        <MetricCard
          title="Guests In House"
          value={loading ? "..." : (data?.inHouse ?? 0)}
          accent="#16a34a"
        />
        <MetricCard
          title="Checkouts Today"
          value={loading ? "..." : (data?.checkoutsToday ?? 0)}
          accent="#f59e0b"
        />
        <MetricCard
          title="Active Locks"
          value={loading ? "..." : (data?.activeLocks ?? 0)}
          accent="#7c3aed"
        />
        <MetricCard
          title="Properties"
          value={loading ? "..." : (data?.properties ?? 0)}
          accent="#0f766e"
        />
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          padding: 18,
          background: "#fff",
          color: "#6b7280",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 8 }}>System Status</div>
        <div style={{ color: "#111827", fontWeight: 600 }}>
          {loading
            ? "Loading..."
            : `Last updated: ${new Date(data?.updatedAt ?? "").toLocaleString()}`}
        </div>
      </div>
    </div>
  );
}