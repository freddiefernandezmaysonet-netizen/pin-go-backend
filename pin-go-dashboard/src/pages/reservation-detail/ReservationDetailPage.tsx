import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type Passcode = {
  id: string;
  method: string;
  status: string;
  startsAt: string;
  endsAt: string;
  codeMasked: string | null;
  lock: {
    id: string;
    ttlockLockId: number;
    name: string | null;
    property: { id: string; name: string };
  };
};

type Nfc = {
  id: string;
  role: string;
  status: string;
  startsAt: string;
  endsAt: string;
  card: {
    id: string;
    label: string | null;
    ttlockCardId: number;
  };
};

type Reservation = {
  id: string;
  guestName: string;
  guestEmail?: string | null;
  roomName?: string | null;
  checkIn: string;
  checkOut: string;
  operationalStatus: string;
  property?: { id: string; name: string } | null;
  passcodes?: Passcode[];
  nfc?: Nfc[];
};

function fmt(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}

function labelizeStatus(value?: string | null) {
  const v = String(value ?? "").trim().toUpperCase();
  if (!v) return "—";
  return v.replaceAll("_", " ");
}

function statusPill(value?: string | null) {
  const v = String(value ?? "").toUpperCase();

  let background = "#f3f4f6";
  let color = "#4b5563";
  let border = "1px solid #e5e7eb";

  if (v === "IN_HOUSE" || v === "ACTIVE") {
    background = "#ecfdf5";
    color = "#065f46";
    border = "1px solid #a7f3d0";
  } else if (v === "UPCOMING" || v === "PENDING") {
    background = "#eff6ff";
    color = "#1d4ed8";
    border = "1px solid #bfdbfe";
  } else if (v === "CHECKED_OUT" || v === "EXPIRED") {
    background = "#f3f4f6";
    color = "#4b5563";
    border = "1px solid #e5e7eb";
  } else if (v === "CANCELLED" || v === "FAILED") {
    background = "#fef2f2";
    color = "#991b1b";
    border = "1px solid #fecaca";
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "5px 10px",
        borderRadius: 999,
        background,
        color,
        border,
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {labelizeStatus(value)}
    </span>
  );
}

function cardStyle() {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 16,
    background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  } as const;
}

function sectionTitleStyle() {
  return {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: "#111827",
  } as const;
}

function mutedStyle() {
  return {
    color: "#6b7280",
  } as const;
}

function Stat({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 16,
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>{value}</div>
    </div>
  );
}

export function ReservationDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setErr(null);

        const res = await fetch(`${API_BASE}/api/dashboard/reservations/${id}`, {
          credentials: "include",
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${text || res.statusText}`);
        }

        const json = (await res.json()) as Reservation;

        if (!cancelled) {
          setData(json);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(String(e?.message ?? e));
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const passcodes = useMemo(() => data?.passcodes ?? [], [data]);
  const nfcCards = useMemo(() => data?.nfc ?? [], [data]);

  if (loading) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Link
          to="/reservations"
          style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
        >
          ← Back to reservations
        </Link>
        <div style={cardStyle()}>Loading reservation...</div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Link
          to="/reservations"
          style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
        >
          ← Back to reservations
        </Link>
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            padding: 16,
            borderRadius: 16,
          }}
        >
          <b>Error loading reservation:</b> {err}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Link
          to="/reservations"
          style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
        >
          ← Back to reservations
        </Link>
        <div style={cardStyle()}>Reservation not found.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Link
          to="/reservations"
          style={{
            color: "#2563eb",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          ← Back to reservations
        </Link>

        <div>{statusPill(data.operationalStatus)}</div>
      </div>

      <div
        style={{
          ...cardStyle(),
          padding: 20,
          borderRadius: 20,
        }}
      >
        <h1
          style={{
            fontSize: 30,
            fontWeight: 800,
            margin: 0,
            color: "#111827",
          }}
        >
          {data.guestName}
        </h1>

        <div style={{ ...mutedStyle(), marginTop: 8, display: "grid", gap: 6 }}>
          <div>
            <b>Property:</b>{" "}
            {data.property ? (
              <Link
                to={`/properties/${data.property.id}`}
                style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
              >
                {data.property.name}
              </Link>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Stat title="Check-in" value={fmt(data.checkIn)} />
        <Stat title="Check-out" value={fmt(data.checkOut)} />
        <Stat title="Operational Status" value={statusPill(data.operationalStatus)} />
        <Stat title="Room" value={data.roomName ?? "—"} />
      </div>

      <div style={cardStyle()}>
        <h3 style={sectionTitleStyle()}>Guest Information</h3>

        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          <div>
            <b>Name:</b> {data.guestName}
          </div>

          <div>
            <b>Email:</b> {data.guestEmail ?? "—"}
          </div>
        </div>
      </div>

      <div style={cardStyle()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h3 style={sectionTitleStyle()}>Passcodes</h3>
          <div style={mutedStyle()}>{passcodes.length} total</div>
        </div>

        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          {passcodes.length === 0 ? (
            <div style={mutedStyle()}>No passcodes.</div>
          ) : (
            passcodes.map((p) => (
              <div
                key={p.id}
                style={{
                  border: "1px solid #eef2f7",
                  borderRadius: 14,
                  padding: 14,
                  background: "#fafafa",
                }}
              >
                <div style={{ display: "grid", gap: 8 }}>
                  <div>
                    <b>Lock:</b>{" "}
                    <Link
                      to={`/locks/${p.lock.id}`}
                      style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
                    >
                      {p.lock.name ?? `Lock ${p.lock.ttlockLockId}`}
                    </Link>
                  </div>

                  <div>
                    <b>Property:</b>{" "}
                    <Link
                      to={`/properties/${p.lock.property.id}`}
                      style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
                    >
                      {p.lock.property.name}
                    </Link>
                  </div>

                  <div>
                    <b>Code:</b> {p.codeMasked ?? "—"}
                  </div>

                  <div>
                    <b>Access Period:</b> {fmt(p.startsAt)} — {fmt(p.endsAt)}
                  </div>

                  <div>
                    <b>Status:</b> {statusPill(p.status)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={cardStyle()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h3 style={sectionTitleStyle()}>NFC Cards</h3>
          <div style={mutedStyle()}>{nfcCards.length} total</div>
        </div>

        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          {nfcCards.length === 0 ? (
            <div style={mutedStyle()}>No NFC cards.</div>
          ) : (
            nfcCards.map((n) => (
              <div
                key={n.id}
                style={{
                  border: "1px solid #eef2f7",
                  borderRadius: 14,
                  padding: 14,
                  background: "#fafafa",
                }}
              >
                <div style={{ display: "grid", gap: 8 }}>
                  <div>
                    <b>Card:</b> {n.card.label ?? `Card #${n.card.ttlockCardId}`}
                  </div>

                  <div>
                    <b>Role:</b> {labelizeStatus(n.role)}
                  </div>

                  <div>
                    <b>Access Period:</b> {fmt(n.startsAt)} — {fmt(n.endsAt)}
                  </div>

                  <div>
                    <b>Status:</b> {statusPill(n.status)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}