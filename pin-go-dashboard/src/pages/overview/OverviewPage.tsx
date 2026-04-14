import { useEffect, useState } from "react";
import { PmsControlCenter } from "../../components/dashboard/PmsControlCenter";
import { LocksCapacityCard } from "../../components/dashboard/LocksCapacityCard";

type MetricsResp = {
  upcomingArrivals: number;
  inHouse: number;
  checkoutsToday: number;
  activeLocks: number;
  properties: number;
  updatedAt: string;
};

type PmsSummaryResp = {
  provider: string | null;
  status: string;
  pendingListings: number;
  mappedListings: number;
  totalListings: number;
  failedWebhookEvents: number;
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

function SmallMetric({
  title,
  value,
}: {
  title: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 16,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>
        {value}
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<MetricsResp | null>(null);
  const [pms, setPms] = useState<PmsSummaryResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    Promise.all([
      fetch(`${API_BASE}/api/dashboard/metrics`, { credentials: "include" }),
      fetch(`${API_BASE}/api/dashboard/pms-summary`, { credentials: "include" }),
    ])
      .then(async ([metricsRes, pmsRes]) => {
        if (!metricsRes.ok) {
          throw new Error("Metrics API error");
        }

        if (!pmsRes.ok) {
          throw new Error("PMS API error");
        }

        const metrics = await metricsRes.json();
        const pmsSummary = await pmsRes.json();

        setData(metrics);
        setPms(pmsSummary);
      })
      .catch((e) => {
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
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        }}
      >
        <MetricCard
          title="Upcoming Arrivals"
          value={loading ? "..." : data?.upcomingArrivals ?? 0}
          accent="#2563eb"
        />

        <MetricCard
          title="Guests In House"
          value={loading ? "..." : data?.inHouse ?? 0}
          accent="#16a34a"
        />

        <MetricCard
          title="Checkouts Today"
          value={loading ? "..." : data?.checkoutsToday ?? 0}
          accent="#f59e0b"
        />

        <MetricCard
          title="Active Locks"
          value={loading ? "..." : data?.activeLocks ?? 0}
          accent="#7c3aed"
        />

        <MetricCard
          title="Properties"
          value={loading ? "..." : data?.properties ?? 0}
          accent="#0f766e"
        />
      </div>
    
    <LocksCapacityCard />

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          padding: 20,
          background: "#fff",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 16,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>PMS Status</div>

            <div style={{ color: "#6b7280", fontSize: 13 }}>
              Property Management System integration health
            </div>
          </div>

          <div
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              background: pms?.status === "ACTIVE" ? "#ecfdf5" : "#f3f4f6",
              color: pms?.status === "ACTIVE" ? "#166534" : "#6b7280",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            {pms?.provider ?? "PMS"} {pms?.status ?? ""}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          }}
        >
          <SmallMetric
            title="Listings Pending Mapping"
            value={loading ? "..." : pms?.pendingListings ?? 0}
          />

          <SmallMetric
            title="Listings Mapped"
            value={loading ? "..." : pms?.mappedListings ?? 0}
          />

          <SmallMetric
            title="Total Listings"
            value={loading ? "..." : pms?.totalListings ?? 0}
          />

          <SmallMetric
            title="Failed Webhooks"
            value={loading ? "..." : pms?.failedWebhookEvents ?? 0}
          />
        </div>
      </div>

      <PmsControlCenter />

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          padding: 18,
          background: "#fff",
          color: "#6b7280",
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 8 }}>System Status</div>

        <div style={{ color: "#111827", fontWeight: 600 }}>
          {loading
            ? "Loading..."
            : `Last updated: ${new Date(
                data?.updatedAt ?? ""
              ).toLocaleString()}`}
        </div>
      </div>
    </div>
  );
}