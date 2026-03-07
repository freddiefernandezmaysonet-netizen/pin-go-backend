import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";

type LockRow = {
  id: string;
  ttlockLockId: number;
  name: string | null;
  isActive: boolean;
  property: { id: string; name: string } | null;
};

type LocksResp = {
  items: LockRow[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: 18,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

export function LockDetailPage() {
  const { id } = useParams();
  const [lock, setLock] = useState<LockRow | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);

    fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=50`)
      .then((r) => r.json())
      .then((data: LocksResp) => {
        const found = data.items?.find((l) => l.id === id) ?? null;
        setLock(found);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div>Loading lock...</div>;
  if (!lock) return <div>Lock not found.</div>;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Link to="/locks">← Back to locks</Link>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700 }}>
          {lock.name ?? "TTLock Lock"}
        </h1>
        <p style={{ color: "#666" }}>
          Property: {lock.property?.name ?? "—"}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(4,1fr)",
        }}
      >
        <Stat label="TTLock ID" value={lock.ttlockLockId} />
        <Stat label="Status" value={lock.isActive ? "ACTIVE" : "DISABLED"} />
        <Stat label="Battery" value="—" />
        <Stat label="Gateway" value="—" />
      </div>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          padding: 18,
          background: "#fff",
        }}
      >
        <h3 style={{ marginBottom: 10 }}>Lock Activity</h3>
        <p style={{ color: "#6b7280" }}>
          Next step: show passcodes, NFC assignments and recent hardware events.
        </p>
      </div>
    </div>
  );
}