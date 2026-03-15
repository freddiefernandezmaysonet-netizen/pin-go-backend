import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type BillingResp = {
  ok: boolean;
  subscription: {
    status: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    entitledLocks: number;
    activeLocks: number;
    remainingLocks: number;
    usagePct: number;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  error?: string;
};

function statusBadgeStyle(status: string | null): React.CSSProperties {
  const s = (status ?? "NO_PLAN").toUpperCase();

  if (s === "ACTIVE") {
    return {
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 999,
      border: "1px solid #bbf7d0",
      background: "#ecfdf5",
      color: "#065f46",
      fontWeight: 700,
    };
  }

  if (s === "PAST_DUE" || s === "UNPAID") {
    return {
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 999,
      border: "1px solid #fecaca",
      background: "#fef2f2",
      color: "#991b1b",
      fontWeight: 700,
    };
  }

  return {
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    color: "#374151",
    fontWeight: 700,
  };
}

export function BillingPage() {
  const navigate = useNavigate();

  const [data, setData] = useState<BillingResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [locks, setLocks] = useState(1);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  async function loadBilling() {
    setLoading(true);
    setErr(null);

    try {
      const res = await fetch(`${API_BASE}/billing/overview`, {
        credentials: "include",
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }

      const json = (await res.json()) as BillingResp;
      setData(json);
    } catch (e: any) {
      console.error("BILLING OVERVIEW ERROR", e);
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBilling();
  }, []);

  async function startUpgrade() {
    try {
      setUpgradeLoading(true);
      setErr(null);

      const res = await fetch(`${API_BASE}/billing/locks/checkout-session`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locks,
        }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(json?.error || `API ${res.status}`);
      }

      if (json?.url) {
        window.location.href = json.url;
        return;
      }

      throw new Error("Stripe checkout URL not returned");
    } catch (e: any) {
      console.error("BILLING UPGRADE ERROR", e);
      setErr(String(e?.message ?? e));
    } finally {
      setUpgradeLoading(false);
    }
  }

  async function openPortal() {
  try {
    setErr(null);

    const res = await fetch(`${API_BASE}/billing/portal`, {
      method: "POST",
      credentials: "include",
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(json?.error || `API ${res.status}`);
    }

    if (json?.url) {
      window.location.href = json.url;
      return;
    }

    throw new Error("Stripe portal URL not returned");
  } catch (e: any) {
    console.error("BILLING PORTAL ERROR", e);
    setErr(String(e?.message ?? e));
  }
}

  const s = data?.subscription;
  const suggestedLocks = Math.max((s?.entitledLocks ?? 0) + 1, 1);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
            Billing
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
            Manage subscription capacity for active locks in Pin&Go.
          </div>
        </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={loadBilling}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 10,
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#111827",
                fontWeight: 700,
                cursor: "pointer",
             }}
          >
             Refresh
           </button>

           <button
             type="button"
             onClick={openPortal}
             style={{
               height: 40,
               padding: "0 14px",
               borderRadius: 10,
               border: "1px solid #d1d5db",
               background: "#ffffff",
               color: "#111827",
               fontWeight: 700,
               cursor: "pointer",
            }}
          >
             Manage Billing
           </button>

           <button
             type="button"
             onClick={() => navigate("/locks")}
             style={{
             height: 40,
             padding: "0 14px",
             borderRadius: 10,
             border: "1px solid #111827",
             background: "#111827",
             color: "#ffffff",
             fontWeight: 700,
             cursor: "pointer",
           }}
         >
           View Subscription
         </button>
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
          }}
        >
          <b>Error:</b> {err}
        </div>
      ) : null}

      {loading ? (
        <div style={{ color: "#666" }}>Loading billing...</div>
      ) : !s ? (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: 16,
            color: "#666",
            background: "#fff",
          }}
        >
          Billing data not available.
        </div>
      ) : (
        <>
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              background: "#fff",
              padding: 20,
              display: "grid",
              gap: 18,
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
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
                  Pin&Go Locks Plan
                </div>
                <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
                  Subscription capacity based on active locks
                </div>
              </div>

              <span style={statusBadgeStyle(s.status)}>
                {(s.status ?? "NO_PLAN").toUpperCase()}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 14,
              }}
            >
              <div
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 14,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 13, color: "#6b7280" }}>Included</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#111827", marginTop: 6 }}>
                  {s.entitledLocks}
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 14,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 13, color: "#6b7280" }}>Active</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#111827", marginTop: 6 }}>
                  {s.activeLocks}
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 14,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 13, color: "#6b7280" }}>Remaining</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#111827", marginTop: 6 }}>
                  {s.remainingLocks}
                </div>
              </div>

              <div
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 14,
                  padding: 14,
                  background: "#f9fafb",
                }}
              >
                <div style={{ fontSize: 13, color: "#6b7280" }}>Usage</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#111827", marginTop: 6 }}>
                  {s.usagePct}%
                </div>
              </div>
            </div>

            <div>
              <div
                style={{
                  width: "100%",
                  height: 12,
                  borderRadius: 999,
                  background: "#e5e7eb",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(s.usagePct, 100)}%`,
                    height: "100%",
                    background: s.usagePct >= 100 ? "#dc2626" : "#2563eb",
                    borderRadius: 999,
                  }}
                />
              </div>

              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                {s.activeLocks} of {s.entitledLocks} active locks in use
              </div>
            </div>
          </div>

          {(s.remainingLocks === 0 || s.cancelAtPeriodEnd || s.status === "PAST_DUE" || s.status === "UNPAID") && (
            <div
              style={{
                border: "1px solid #fde68a",
                borderRadius: 14,
                background: "#fffbeb",
                padding: 14,
                color: "#92400e",
                fontSize: 14,
              }}
            >
              <div style={{ fontWeight: 700 }}>Billing attention needed</div>

              {s.remainingLocks === 0 ? (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Your organization has reached its active lock capacity. Upgrade the plan to activate additional locks.
                </div>
              ) : null}

              {s.cancelAtPeriodEnd ? (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Subscription is set to cancel at the end of the current billing period.
                </div>
              ) : null}

              {s.status === "PAST_DUE" || s.status === "UNPAID" ? (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Your billing status requires attention. Review payment and subscription details.
                </div>
              ) : null}
            </div>
          )}

          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              background: "#fff",
              padding: 20,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
              Billing Cycle
            </div>

            <div style={{ fontSize: 14, color: "#374151" }}>
              Current period: {s.currentPeriodStart ?? "—"} → {s.currentPeriodEnd ?? "—"}
            </div>

            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Stripe customer: {s.stripeCustomerId ?? "—"}
            </div>

            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Stripe subscription: {s.stripeSubscriptionId ?? "—"}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              background: "#fff",
              padding: 20,
              display: "grid",
              gap: 14,
            }}
          >
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>
                Upgrade Capacity
              </div>
              <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
                Increase the number of locks included in your subscription.
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <input
                type="number"
                min={1}
                value={locks}
                onChange={(e) => setLocks(Number(e.target.value))}
                style={{
                  height: 42,
                  width: 140,
                  borderRadius: 10,
                  border: "1px solid #d1d5db",
                  padding: "0 12px",
                  fontSize: 14,
                }}
              />

              <button
                type="button"
                onClick={startUpgrade}
                disabled={upgradeLoading}
                style={{
                  height: 42,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "#ffffff",
                  fontWeight: 700,
                  cursor: upgradeLoading ? "default" : "pointer",
                  opacity: upgradeLoading ? 0.7 : 1,
                }}
              >
                {upgradeLoading ? "Redirecting..." : "Upgrade Locks"}
              </button>

              <button
                type="button"
                onClick={() => setLocks(suggestedLocks)}
                style={{
                  height: 42,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                  color: "#111827",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Suggest Next Tier
              </button>
            </div>

            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Recommended next capacity: {suggestedLocks} locks
            </div>
          </div>
        </>
      )}
    </div>
  );
}