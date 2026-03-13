import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ActivateLockModal } from "../../components/dashboard/ActivateLockModal";

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
  operationalStatus: "UPCOMING" | "IN_HOUSE" | "CHECKED_OUT" | "CANCELLED";
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
    status?: string;
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
        display: "grid",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 14px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        background: active ? "#111827" : "#ffffff",
        color: active ? "#ffffff" : "#374151",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function fmt(d: string) {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}

function operationalBadge(status: ReservationRow["operationalStatus"]) {
  let background = "#f3f4f6";
  let color = "#4b5563";
  let border = "1px solid #e5e7eb";
  let label = status;

  if (status === "UPCOMING") {
    background = "#eff6ff";
    color = "#1d4ed8";
    border = "1px solid #bfdbfe";
    label = "UPCOMING";
  } else if (status === "IN_HOUSE") {
    background = "#ecfdf5";
    color = "#065f46";
    border = "1px solid #a7f3d0";
    label = "IN HOUSE";
  } else if (status === "CHECKED_OUT") {
    background = "#f3f4f6";
    color = "#4b5563";
    border = "1px solid #e5e7eb";
    label = "CHECKED OUT";
  } else if (status === "CANCELLED") {
    background = "#fef2f2";
    color = "#991b1b";
    border = "1px solid #fecaca";
    label = "CANCELLED";
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        background,
        color,
        border,
      }}
    >
      {label}
    </span>
  );
}

function accessStatusBadge(status?: string) {
  const normalized = String(status ?? "").toUpperCase();

  let background = "#f3f4f6";
  let color = "#4b5563";
  let border = "1px solid #e5e7eb";
  let label = normalized || "—";

  if (normalized === "ACTIVE") {
    background = "#ecfdf5";
    color = "#065f46";
    border = "1px solid #a7f3d0";
  } else if (normalized === "PENDING") {
    background = "#eff6ff";
    color = "#1d4ed8";
    border = "1px solid #bfdbfe";
  } else if (normalized === "FAILED" || normalized === "CANCELLED") {
    background = "#fef2f2";
    color = "#991b1b";
    border = "1px solid #fecaca";
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        background,
        color,
        border,
      }}
    >
      {label}
    </span>
  );
}

export function PropertyDetailPage() {
  const { id } = useParams();
  const [tab, setTab] = useState<"overview" | "locks" | "reservations" | "access">("overview");

  const [item, setItem] = useState<PropertyRow | null>(null);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [access, setAccess] = useState<AccessResp | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openAddLock, setOpenAddLock] = useState(false);

  const loadData = useCallback(async () => {
    if (!id) return;

    setLoading(true);
    setErr(null);

    try {
      const [propsData, locksData, reservationsData, accessData] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/properties`, { credentials: "include" }).then(async (res) => {
          if (!res.ok) throw new Error(`Properties ${res.status}`);
          return res.json() as Promise<PropertiesResp>;
        }),
        fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=20&propertyId=${id}`, {
          credentials: "include",
        }).then(async (res) => {
          if (!res.ok) throw new Error(`Locks ${res.status}`);
          return res.json() as Promise<LocksResp>;
        }),
        fetch(`${API_BASE}/api/dashboard/reservations?page=1&pageSize=50&propertyId=${id}`, {
          credentials: "include",
        }).then(async (res) => {
          if (!res.ok) throw new Error(`Reservations ${res.status}`);
          return res.json() as Promise<ReservationsResp>;
        }),
        fetch(`${API_BASE}/api/dashboard/access?propertyId=${id}`, {
          credentials: "include",
        }).then(async (res) => {
          if (!res.ok) throw new Error(`Access ${res.status}`);
          return res.json() as Promise<AccessResp>;
        }),
      ]);

      const found = (propsData.items ?? []).find((x) => x.id === id) ?? null;
      setItem(found);
      setLocks(locksData.items ?? []);
      setReservations(reservationsData.items ?? []);
      setAccess(accessData);
    } catch (e: any) {
      console.error("PROPERTY DETAIL ERROR", e);
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const upcomingReservations = useMemo(
    () => (reservations ?? []).filter((r) => r.operationalStatus === "UPCOMING"),
    [reservations]
  );

  const activeGuestPasscodes = useMemo(
    () =>
      (access?.guestPasscodes ?? []).filter(
        (g) => String(g.status ?? "").toUpperCase() === "ACTIVE"
      ),
    [access]
  );

  const activeNfc = useMemo(
    () => (access?.nfc ?? []).filter((n) => String(n.status ?? "").toUpperCase() === "ACTIVE"),
    [access]
  );

  const accessCount = useMemo(
    () => activeGuestPasscodes.length + activeNfc.length,
    [activeGuestPasscodes, activeNfc]
  );

  const hasActiveLock = useMemo(
    () => locks.some((l) => l.isActive),
    [locks]
  );

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
    <>
      <div style={{ display: "grid", gap: 20 }}>
        <div>
          <Link to="/properties" style={{ color: "#2563eb", textDecoration: "none" }}>
            ← Back to properties
          </Link>
        </div>

        <div>
          <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0 }}>{item.name}</h1>
          <p style={{ color: "#666", marginTop: 8 }}>Property operational overview.</p>
        </div>

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          }}
        >
          <Stat title="Locks" value={item.locks} />
          <Stat title="Upcoming Reservations" value={upcomingReservations.length} />
          <Stat title="PMS" value={String(item.pms).toUpperCase()} />
          <Stat title="Active Access" value={accessCount} />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} label="Overview" />
          <TabButton active={tab === "locks"} onClick={() => setTab("locks")} label={`Locks (${locks.length})`} />
          <TabButton
            active={tab === "reservations"}
            onClick={() => setTab("reservations")}
            label={`Reservations (${upcomingReservations.length})`}
          />
          <TabButton active={tab === "access"} onClick={() => setTab("access")} label={`Access (${accessCount})`} />
        </div>

        {tab === "overview" && (
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "1fr 1fr",
              alignItems: "start",
            }}
          >
            <SectionCard title="Property Summary">
              <div style={{ color: "#6b7280", lineHeight: 1.7 }}>
                {item.name} currently has <b>{item.locks}</b> active lock(s), <b>{upcomingReservations.length}</b>{" "}
                upcoming reservation(s), and PMS source <b>{String(item.pms).toUpperCase()}</b>.
              </div>
            </SectionCard>

            <SectionCard title="Operational Health">
              <div style={{ color: "#6b7280", lineHeight: 1.7 }}>
                This view is focused on <b>upcoming reservations</b> and <b>active access</b> for this property.
              </div>
            </SectionCard>
          </div>
        )}

        {tab === "locks" && (
          <SectionCard
            title={`Locks (${locks.length})`}
            right={
              <button
                onClick={() => {
                  if (!hasActiveLock) setOpenAddLock(true);
                }}
                disabled={hasActiveLock}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #111827",
                  background: hasActiveLock ? "#e5e7eb" : "#111827",
                  color: hasActiveLock ? "#6b7280" : "#fff",
                  fontWeight: 700,
                  cursor: hasActiveLock ? "not-allowed" : "pointer",
                }}
              >
                {hasActiveLock ? "Lock Already Assigned" : "Add Lock"}
              </button>
            }
          >
            {hasActiveLock ? (
              <div
                style={{
                  borderRadius: 12,
                  padding: 12,
                  background: "#fffbeb",
                  border: "1px solid #fcd34d",
                  color: "#92400e",
                  fontSize: 14,
                }}
              >
                This property already has an active lock. Use Swap Lock from Lock Detail to replace the device.
              </div>
            ) : null}

            {locks.length === 0 ? (
              <div style={{ color: "#666" }}>No locks found for this property yet.</div>
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
                      <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
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
        )}

        {tab === "reservations" && (
          <SectionCard title={`Upcoming Reservations (${upcomingReservations.length})`}>
            {upcomingReservations.length === 0 ? (
              <div style={{ color: "#666" }}>No upcoming reservations found.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {upcomingReservations.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      border: "1px solid #f3f4f6",
                      borderRadius: 12,
                      padding: 12,
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{r.guestName}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      {fmt(r.checkIn)} → {fmt(r.checkOut)}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ color: "#6b7280", fontSize: 12 }}>
                        {String(r.externalProvider ?? r.source ?? "—").toUpperCase()}
                      </span>
                      {operationalBadge(r.operationalStatus)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        )}

        {tab === "access" && (
          <SectionCard title={`Active Access (${accessCount})`}>
            {accessCount === 0 ? (
              <div style={{ color: "#666" }}>No active access found.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {activeGuestPasscodes.map((g) => (
                  <div
                    key={g.grantId}
                    style={{
                      border: "1px solid #f3f4f6",
                      borderRadius: 12,
                      padding: 12,
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>PASSCODE · {g.guestName}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>{g.lock?.name ?? "—"}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      Access Period: {fmt(g.startsAt)} — {fmt(g.endsAt)}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ color: "#6b7280", fontSize: 12 }}>Code: {g.codeMasked ?? "—"}</span>
                      {accessStatusBadge(g.status)}
                    </div>
                  </div>
                ))}

                {activeNfc.map((n) => (
                  <div
                    key={n.assignmentId}
                    style={{
                      border: "1px solid #f3f4f6",
                      borderRadius: 12,
                      padding: 12,
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      NFC · {n.role} · {n.guestName}
                    </div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      Card: {n.card?.label ?? "—"}
                    </div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>
                      Access Period: {fmt(n.startsAt)} — {fmt(n.endsAt)}
                    </div>
                    <div>{accessStatusBadge(n.status)}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        )}
      </div>

      <ActivateLockModal
        open={openAddLock}
        propertyId={item.id}
        propertyName={item.name}
        onClose={() => setOpenAddLock(false)}
        onActivated={async () => {
          setOpenAddLock(false);
          await loadData();
        }}
      />
    </>
  );
}