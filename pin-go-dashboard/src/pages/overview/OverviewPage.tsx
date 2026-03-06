import { useDashboardOverview } from "../../api/hooks";

function Card({
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
        borderRadius: 16,
        padding: 20,
        background: "#fff",
      }}
    >
      <div style={{ color: "#666", fontSize: 14, marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 32, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

export function OverviewPage() {
  const { data, isLoading, error } = useDashboardOverview();

  if (error) {
    return <div>Error: {(error as Error).message}</div>;
  }

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Overview</h1>
        <p style={{ color: "#666" }}>Live metrics from Pin&Go backend.</p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        }}
      >
        <Card
          title="Active Reservations"
          value={isLoading ? "..." : (data?.activeReservations ?? 0)}
        />
        <Card
          title="Check-ins Today"
          value={isLoading ? "..." : (data?.checkInsToday ?? 0)}
        />
        <Card
          title="Check-outs Today"
          value={isLoading ? "..." : (data?.checkOutsToday ?? 0)}
        />
        <Card
          title="Active Locks"
          value={isLoading ? "..." : (data?.activeLocks ?? 0)}
        />
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 20,
          color: "#666",
        }}
      >
        Last updated:{" "}
        {isLoading ? "..." : new Date(data?.updatedAt ?? "").toLocaleString()}
      </div>
    </div>
  );
}