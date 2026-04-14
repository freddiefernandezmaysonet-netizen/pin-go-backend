import { useEffect, useState } from "react";

type AccessRow = {
  id: string;
  type: "PASSCODE" | "NFC";
  name: string;
  lock: string;
  property: string;
  startsAt: string;
  endsAt: string;
  status: string;
};

type AccessResp = {
  now: string;
  guestPasscodes: Array<{
    grantId: string;
    reservationId: string | null;
    guestName: string;
    roomName: string | null;
    property: { id: string; name: string } | null;
    lock: { ttlockLockId: number; name: string | null } | null;
    startsAt: string;
    endsAt: string;
    codeMasked: string | null;
    ttlockKeyboardPwdId: number | null;
    lastError: string | null;
  }>;
  nfc: Array<{
    assignmentId: string;
    reservationId: string;
    guestName: string;
    roomName: string | null;
    property: { id: string; name: string };
    role: string;
    status: string;
    card: { id: string; label: string | null; ttlockCardId: number };
    startsAt: string;
    endsAt: string;
    lastError: string | null;
  }>;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export function AccessPage() {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);

    fetch(`${API_BASE}/api/dashboard/access`, {
      credentials: "include",
    })
      .then(async (r) => {
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`API ${r.status}: ${t || r.statusText}`);
        }
        return r.json();
      })
      .then((data: AccessResp) => {
        const list: AccessRow[] = [];

        data.guestPasscodes?.forEach((g) => {
          list.push({
            id: g.grantId,
            type: "PASSCODE",
            name: g.guestName ?? "Guest",
            lock: g.lock?.name ?? (g.lock?.ttlockLockId ? String(g.lock.ttlockLockId) : "—"),
            property: g.property?.name ?? "—",
            startsAt: g.startsAt,
            endsAt: g.endsAt,
            status: "ACTIVE",
          });
        });

        data.nfc?.forEach((n) => {
          list.push({
            id: n.assignmentId,
            type: "NFC",
            name: `${n.role}${n.guestName ? ` - ${n.guestName}` : ""}`,
            lock: n.card?.label ?? `Card #${n.card?.ttlockCardId ?? ""}`,
            property: n.property?.name ?? "—",
            startsAt: n.startsAt,
            endsAt: n.endsAt,
            status: n.status ?? "ACTIVE",
          });
        });

        setRows(list);
      })
      .catch((e) => {
        console.error("ACCESS ERROR", e);
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          overflow: "hidden",
          background: "#fff",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: "#f9fafb" }}>
            <tr>
              {["Type", "Name", "Property", "Lock / Card", "Start", "End", "Status"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    fontSize: 12,
                    padding: 12,
                    borderBottom: "1px solid #e5e7eb",
                    color: "#666",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} style={{ padding: 16 }}>
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 16 }}>
                  No active access.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: 12 }}>{r.type}</td>
                  <td style={{ padding: 12 }}>{r.name}</td>
                  <td style={{ padding: 12 }}>{r.property}</td>
                  <td style={{ padding: 12 }}>{r.lock}</td>
                  <td style={{ padding: 12 }}>{new Date(r.startsAt).toLocaleString()}</td>
                  <td style={{ padding: 12 }}>{new Date(r.endsAt).toLocaleString()}</td>
                  <td style={{ padding: 12 }}>{r.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}