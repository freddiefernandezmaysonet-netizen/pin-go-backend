import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";

type PropertyRow = {
  id: string;
  name: string;
  locks: number;
  activeReservations: number;
  pms: string;
  status: string;
};

type PropertiesResp = {
  items: PropertyRow[];
};

type LockRow = {
  id: string;
  ttlockLockId: number;
  name: string | null;
  isActive: boolean;
  property: { id: string; name: string } | null;
};

type LocksResp = {
  page: number;
  pageSize: number;
  total: number;
  items: LockRow[];
};

type ReservationRow = {
  id: string;
  guestName: string;
  guestEmail?: string | null;
  roomName?: string | null;
  checkIn: string;
  checkOut: string;
  status: "ACTIVE" | "CANCELLED";
  source?: string | null;
  externalProvider?: string | null;
  property?: { id: string; name: string } | null;
};

type ReservationsResp = {
  page: number;
  pageSize: number;
  total: number;
  items: ReservationRow[];
};

type AccessResp = {
  now: string;
  guestPasscodes: Array<{
    grantId: string;
    guestName: string;
    property: { id: string; name: string } | null;
    lock: { ttlockLockId: number; name: string | null } | null;
    startsAt: string;
    endsAt: string;
    codeMasked: string | null;
  }>;
  nfc: Array<{
    assignmentId: string;
    guestName: string;
    property: { id: string; name: string };
    role: string;
    status: string;
    card: { id: string; label: string | null; ttlockCardId: number };
    startsAt: string;
    endsAt: string;
  }>;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function Stat({ title, value }: { title: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: 18,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#111827" }}>{value}</div>
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
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  );
}

function fmt(d: string) {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}

export function PropertyDetailPage() {
  const { id } = useParams();

  const [item, setItem] = useState<PropertyRow | null>(null);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [access, setAccess] = useState<AccessResp | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    setLoading(true);
    setErr(null);

    Promise.all([
      fetch(`${API_BASE}/api/dashboard/properties`).then(async (res) => {
        if (!res.ok) throw new Error(`Properties ${res.status}`);
        return res.json() as Promise<PropertiesResp>;
      }),
      fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=20&propertyId=${id}`).then(async (res) => {
        if (!res.ok) throw new Error(`Locks ${res.status}`);
        return res.json() as Promise<LocksResp>;
      }),
      fetch(`${API_BASE}/api/dashboard/reservations?page=1&pageSize=10&propertyId=${id}`).then(async (res) => {
        if (!res.ok) throw new Error(`Reservations ${res.status}`);
        return res.json() as Promise<ReservationsResp>;
      }),
      fetch(`${API_BASE}/api/dashboard/access?propertyId=${id}`).then(async (res) => {
        if (!res.ok) throw new Error(`Access ${res.status}`);
        return res.json() as Promise<AccessResp>;
      }),
    ])
      .then(([propsData, locksData, reservationsData, accessData]) => {
        const found = (propsData.items ?? []).find((x) => x.id === id) ?? null;
        setItem(found);
        setLocks(locksData.items ?? []);
        setReservations(reservationsData.items ?? []);
        setAccess(accessData);
      })
      .catch((e) => {
        console.error("PROPERTY DETAIL ERROR", e);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div style={{ color: "#666" }}>Loading property...</div>;
  }

  if (err) {
    return (
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
    );
  }

  if (!item) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ color: "#666" }}>Property not found.</div>
        <Link to="/properties">Back to properties</Link>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <Link to="/properties" style={{ color: "#2563eb", textDecoration: "none" }}>
          ← Back to properties
        </Link>
      </div>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0 }}>{item.name}</h1>
        <p style={{ color: "#666", marginTop: 8 }}>
          Property operational overview.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        }}
      >
        <Stat title="Locks" value={item.locks} />
        <Stat title="Active Reservations" value={item.activeReservations} />
        <Stat title="PMS" value={String(item.pms).toUpperCase()} />
        <Stat title="Status" value={item.status} />
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "1fr 1fr",
          alignItems: "start",
        }}
      >
        <SectionCard title={`Locks (${locks.length})`}>
          {locks.length === 0 ? (
            <div style={{ color: "#666" }}>No locks found.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {locks.map((l) => (
                <div
                  key={l.id}
                  style={{
                    border: "1px solid #f3f4f6",
                    borderRadius: 12,
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{l.name ?? "TTLock Lock"}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      TTLock ID: {l.ttlockLockId}
                    </div>
                  </div>
                  <div>
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
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={`Reservations (${reservations.length})`}>
          {reservations.length === 0 ? (
            <div style={{ color: "#666" }}>No reservations found.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {reservations.map((r) => (
                <div
                  key={r.id}
                  style={{
                    border: "1px solid #f3f4f6",
                    borderRadius: 12,
                    padding: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{r.guestName}</div>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>
                    {fmt(r.checkIn)} → {fmt(r.checkOut)}
                  </div>
                  <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
                    {r.externalProvider ?? r.source ?? "—"} · {r.status}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title={`Access (${(access?.guestPasscodes?.length ?? 0) + (access?.nfc?.length ?? 0)})`}
      >
        {!access ? (
          <div style={{ color: "#666" }}>No access data.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {(access.guestPasscodes ?? []).map((g) => (
              <div
                key={g.grantId}
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>PASSCODE · {g.guestName}</div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  {g.lock?.name ?? g.lock?.ttlockLockId ?? "—"}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  {fmt(g.startsAt)} → {fmt(g.endsAt)}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  Code: {g.codeMasked ?? "—"}
                </div>
              </div>
            ))}

            {(access.nfc ?? []).map((n) => (
              <div
                key={n.assignmentId}
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  NFC · {n.role} · {n.guestName}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  Card: {n.card?.label ?? `#${n.card?.ttlockCardId ?? ""}`}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  {fmt(n.startsAt)} → {fmt(n.endsAt)}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  Status: {n.status}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}