import { useDashboardOverview } from "../../api/hooks";

function StatCard({
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
  const { data, isLoading, error } = useDashboardOverview();

  if (error) {
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
        Error: {(error as Error).message}
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
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        }}
      >
        <StatCard
          title="Active Reservations"
          value={isLoading ? "..." : (data?.activeReservations ?? 0)}
          accent="#2563eb"
        />
        <StatCard
          title="Check-ins Today"
          value={isLoading ? "..." : (data?.checkInsToday ?? 0)}
          accent="#16a34a"
        />
        <StatCard
          title="Check-outs Today"
          value={isLoading ? "..." : (data?.checkOutsToday ?? 0)}
          accent="#f59e0b"
        />
        <StatCard
          title="Active Locks"
          value={isLoading ? "..." : (data?.activeLocks ?? 0)}
          accent="#7c3aed"
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
          {isLoading
            ? "Loading..."
            : `Last updated: ${new Date(data?.updatedAt ?? "").toLocaleString()}`}
        </div>
      </div>
    </div>
  );
}