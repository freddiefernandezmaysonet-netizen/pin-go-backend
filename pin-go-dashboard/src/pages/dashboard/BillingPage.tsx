import { useEffect, useMemo, useState } from "react";
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

type PreviewLine = {
  description: string | null;
  amount: number;
};

type BillingPreviewResp = {
  ok: boolean;
  amountDue: number;
  currency: string;
  nextTotal: number;
  lines: PreviewLine[];
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

function formatMoney(amountMinor: number, currency: string) {
  const value = Number(amountMinor ?? 0) / 100;
  const code = (currency || "usd").toUpperCase();

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

function formatDate(value: string | null) {
  if (!value) return "—";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function BillingPage() {
  const navigate = useNavigate();

  const [data, setData] = useState<BillingResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [locks, setLocks] = useState(1);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  const [preview, setPreview] = useState<BillingPreviewResp | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const s = data?.subscription ?? null;
  const hasExistingSubscription = Boolean(s?.stripeSubscriptionId);

  useEffect(() => {
    if (!s) return;

    const base = Math.max(s.entitledLocks, s.activeLocks, 1);
    setLocks(base);
  }, [s?.stripeSubscriptionId, s?.entitledLocks, s?.activeLocks]);

  async function loadPreview(quantity: number) {
    if (!hasExistingSubscription) {
      setPreview(null);
      return;
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      setPreview(null);
      return;
    }

    try {
      setPreviewLoading(true);

      const res = await fetch(`${API_BASE}/billing/locks/preview`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ quantity }),
      });

      const json = (await res.json().catch(() => null)) as BillingPreviewResp | null;

      if (!res.ok || !json?.ok) {
        setPreview(null);
        return;
      }

      setPreview(json);
    } catch (e) {
      console.error("PREVIEW ERROR", e);
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (!s?.stripeSubscriptionId) {
      setPreview(null);
      return;
    }

    if (!Number.isInteger(locks) || locks < 1) {
      setPreview(null);
      return;
    }

    void loadPreview(locks);
  }, [locks, s?.stripeSubscriptionId]);

  async function startUpgrade() {
    try {
      setUpgradeLoading(true);
      setErr(null);

      if (hasExistingSubscription) {
        const res = await fetch(`${API_BASE}/billing/locks/quantity`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            quantity: locks,
          }),
        });

        const json = await res.json().catch(() => null);

        if (!res.ok) {
          if (json?.error === "SUBSCRIPTION_BELOW_ACTIVE_LOCKS") {
            throw new Error(
              `You cannot reduce capacity below active locks. Active locks: ${
                json?.activeLocks ?? "unknown"
              }, requested: ${json?.requestedQuantity ?? locks}.`
            );
          }

          throw new Error(json?.error || `API ${res.status}`);
        }

        await loadBilling();
        await loadPreview(locks);
        return;
      }

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

  const suggestedLocks = useMemo(() => {
    if (!s) return 1;
    return Math.max(s.entitledLocks, s.activeLocks, 1);
  }, [s]);

  const changeType = useMemo(() => {
    if (!s) return "new";
    if (locks > s.entitledLocks) return "upgrade";
    if (locks < s.entitledLocks) return "downgrade";
    return "same";
  }, [locks, s]);

  const primaryButtonLabel = useMemo(() => {
    if (!hasExistingSubscription) return "Start Subscription";
    if (changeType === "upgrade") return "Update Capacity";
    if (changeType === "downgrade") return "Reduce Capacity";
    return "Save Capacity";
  }, [hasExistingSubscription, changeType]);

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
            Manage subscription capacity for active locks in Pin&amp;Go.
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
            background: "#ffffff",
          }}
        >
          No billing data available.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 16,
                background: "#ffffff",
              }}
            >
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                Subscription Status
              </div>
              <div style={statusBadgeStyle(s.status)}>{s.status ?? "NO_PLAN"}</div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 16,
                background: "#ffffff",
              }}
            >
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                Entitled Locks
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.entitledLocks}
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 16,
                background: "#ffffff",
              }}
            >
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                Active Locks
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.activeLocks}
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 16,
                background: "#ffffff",
              }}
            >
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                Remaining Capacity
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.remainingLocks}
              </div>
            </div>
          </div>

          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 18,
              background: "#ffffff",
              display: "grid",
              gap: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
                  Capacity Management
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                  Adjust your total lock capacity. Existing subscriptions update with
                  prorated billing.
                </div>
              </div>

              <div style={{ fontSize: 13, color: "#6b7280" }}>
                Current period: {formatDate(s.currentPeriodStart)} →{" "}
                {formatDate(s.currentPeriodEnd)}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(220px, 320px) 1fr",
                gap: 18,
              }}
            >
              <div style={{ display: "grid", gap: 12 }}>
                <label
                  htmlFor="locks-capacity"
                  style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}
                >
                  Total locks desired
                </label>

                <input
                  id="locks-capacity"
                  type="number"
                  min={1}
                  step={1}
                  value={locks}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setLocks(Number.isFinite(next) ? Math.max(1, Math.floor(next)) : 1);
                  }}
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid #d1d5db",
                    padding: "0 12px",
                    fontSize: 16,
                    fontWeight: 700,
                  }}
                />

                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  Suggested starting point: {suggestedLocks}
                </div>

                <button
                  type="button"
                  onClick={startUpgrade}
                  disabled={upgradeLoading || locks < 1}
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid #111827",
                    background: upgradeLoading ? "#9ca3af" : "#111827",
                    color: "#ffffff",
                    fontWeight: 800,
                    cursor: upgradeLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {upgradeLoading ? "Saving..." : primaryButtonLabel}
                </button>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    background: "#f9fafb",
                    padding: 14,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>
                    Billing Preview
                  </div>

                  {!hasExistingSubscription ? (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      A secure checkout session will be created for your first
                      subscription.
                    </div>
                  ) : previewLoading ? (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      Loading preview...
                    </div>
                  ) : preview ? (
                    <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#6b7280",
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                          }}
                        >
                          Estimated charge now
                        </div>
                        <div
                          style={{
                            fontSize: 28,
                            fontWeight: 800,
                            color: "#111827",
                            marginTop: 4,
                          }}
                        >
                          {formatMoney(preview.amountDue, preview.currency)}
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#6b7280",
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                          }}
                        >
                          Upcoming invoice total
                        </div>
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: "#111827",
                            marginTop: 4,
                          }}
                        >
                          {formatMoney(preview.nextTotal, preview.currency)}
                        </div>
                      </div>

                      {preview.lines?.length ? (
                        <div
                          style={{
                            borderTop: "1px solid #e5e7eb",
                            paddingTop: 10,
                            display: "grid",
                            gap: 8,
                          }}
                        >
                          {preview.lines.map((line, idx) => (
                            <div
                              key={`${line.description ?? "line"}-${idx}`}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 12,
                                alignItems: "flex-start",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "#374151",
                                  lineHeight: 1.35,
                                }}
                              >
                                {line.description ?? "Subscription adjustment"}
                              </div>
                              <div
                                style={{
                                  fontSize: 13,
                                  fontWeight: 700,
                                  color: "#111827",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {formatMoney(line.amount, preview.currency)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        Stripe preview only. Final invoice may vary slightly based on
                        taxes, credits, or timing.
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      Preview unavailable for the selected quantity.
                    </div>
                  )}
                </div>

                <div
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    background: "#ffffff",
                    padding: 14,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>
                    Capacity Rules
                  </div>

                  <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                    <div style={{ fontSize: 13, color: "#374151" }}>
                      • You can increase capacity at any time.
                    </div>
                    <div style={{ fontSize: 13, color: "#374151" }}>
                      • You cannot reduce capacity below active locks.
                    </div>
                    <div style={{ fontSize: 13, color: "#374151" }}>
                      • Quantity is treated as total desired capacity, not a delta.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}