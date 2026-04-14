import { useEffect, useState } from "react";
import { getOrganizationId } from "../../lib/getOrganizationId";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type PmsItem = {
  provider: string;
  connected: boolean;
  status: string;
  accountName?: string | null;
  lastConfiguredAt?: string | null;
  pendingListings: number;
  mappedListings: number;
  totalListings: number;
  failedWebhookEvents: number;
};

type PmsSummaryResp = {
  items: PmsItem[];
  totals: {
    pendingListings: number;
    mappedListings: number;
    totalListings: number;
    failedWebhookEvents: number;
  };
};

function sectionStyle(): React.CSSProperties {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 20,
    background: "#fff",
  };
}

function miniCardStyle(): React.CSSProperties {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 16,
    background: "#fff",
  };
}

function badgeStyle(
  tone: "success" | "warning" | "neutral" | "error"
): React.CSSProperties {
  if (tone === "success") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "6px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 700,
      background: "#ecfdf5",
      color: "#166534",
      border: "1px solid #bbf7d0",
    };
  }

  if (tone === "warning") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "6px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 700,
      background: "#fffbeb",
      color: "#92400e",
      border: "1px solid #fde68a",
    };
  }

  if (tone === "error") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "6px 10px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 700,
      background: "#fef2f2",
      color: "#991b1b",
      border: "1px solid #fecaca",
    };
  }

  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    background: "#f3f4f6",
    color: "#6b7280",
    border: "1px solid #e5e7eb",
  };
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function statusTone(item: PmsItem): "success" | "warning" | "neutral" | "error" {
  if (!item.connected) return "neutral";
  if (item.failedWebhookEvents > 0) return "error";
  if (item.pendingListings > 0) return "warning";
  if ((item.status ?? "").toUpperCase() === "ACTIVE") return "success";
  return "neutral";
}

function statusLabel(item: PmsItem) {
  if (!item.connected) return "NOT CONFIGURED";
  return item.status;
}

export function PmsControlCenter() {
  const [data, setData] = useState<PmsSummaryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    fetch(`${API_BASE}/api/dashboard/pms-summary`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`API ${res.status}: ${t || res.statusText}`);
        }
        return res.json();
      })
      .then((json: PmsSummaryResp) => {
        setData(json);
      })
      .catch((e) => {
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <section style={sectionStyle()}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>PMS Control Center</h3>
          <p style={{ margin: "6px 0 0 0", color: "#6b7280", fontSize: 14 }}>
            Connection health, listings mapping, and webhook readiness by provider.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridAutoFlow: "column",
            gap: 10,
          }}
        >
          <div style={miniCardStyle()}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Total Listings
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {loading ? "..." : (data?.totals.totalListings ?? 0)}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Pending
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {loading ? "..." : (data?.totals.pendingListings ?? 0)}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Failed Webhooks
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {loading ? "..." : (data?.totals.failedWebhookEvents ?? 0)}
            </div>
          </div>
        </div>
      </div>

      {err ? (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            padding: 12,
            borderRadius: 12,
            color: "#991b1b",
            fontSize: 14,
          }}
        >
          Error loading PMS summary: {err}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        }}
      >
        {(data?.items ?? []).map((item) => (
          <div
            key={item.provider}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 16,
              background: "#fff",
              display: "grid",
              gap: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{item.provider}</div>
                <div style={{ color: "#6b7280", fontSize: 13, marginTop: 4 }}>
                  {item.accountName ?? "No account name"}
                </div>
              </div>

              <span style={badgeStyle(statusTone(item))}>{statusLabel(item)}</span>
            </div>

            <div
              style={{
                display: "grid",
                gap: 10,
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              }}
            >
              <div style={miniCardStyle()}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                  Listings
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {item.totalListings}
                </div>
              </div>

              <div style={miniCardStyle()}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                  Mapped
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {item.mappedListings}
                </div>
              </div>

              <div style={miniCardStyle()}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                  Pending
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {item.pendingListings}
                </div>
              </div>

              <div style={miniCardStyle()}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                  Failed Webhooks
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {item.failedWebhookEvents}
                </div>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: 12,
                background: "#f9fafb",
                color: "#374151",
                fontSize: 14,
              }}
            >
              Last configured: {formatDate(item.lastConfiguredAt)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}