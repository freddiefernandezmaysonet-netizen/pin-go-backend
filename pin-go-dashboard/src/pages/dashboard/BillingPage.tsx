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
    entitledSmartProperties: number;
    activeSmartProperties: number;
    remainingSmartProperties: number;
    smartUsagePct: number;
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

type TuyaAccessResp = {
  ok: boolean;
  tuya?: {
    state?: "locked" | "pending_onboarding" | "connected";
    hasEntitlement?: boolean;
    hasTuyaUid?: boolean;
  };
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

function addonBadgeStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        fontSize: 12,
        padding: "4px 8px",
        borderRadius: 999,
        border: "1px solid #bbf7d0",
        background: "#ecfdf5",
        color: "#065f46",
        fontWeight: 700,
      }
    : {
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

  const [smartQuantity, setSmartQuantity] = useState(1);
  const [smartUpdateLoading, setSmartUpdateLoading] = useState(false);
  const [smartPreview, setSmartPreview] = useState<BillingPreviewResp | null>(null);
  const [smartPreviewLoading, setSmartPreviewLoading] = useState(false);

  const [tuyaState, setTuyaState] = useState<
    "locked" | "pending_onboarding" | "connected"
  >("locked");
  const [tuyaLoading, setTuyaLoading] = useState(false);

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
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function loadTuyaState() {
    try {
      setTuyaLoading(true);

      const res = await fetch(`${API_BASE}/api/org/tuya/access/status`, {
        credentials: "include",
      });

      const json = (await res.json().catch(() => null)) as TuyaAccessResp | null;

      if (!res.ok || !json?.ok) {
        setTuyaState("locked");
        return;
      }

      setTuyaState(json.tuya?.state ?? "locked");
    } catch (e) {
      setTuyaState("locked");
    } finally {
      setTuyaLoading(false);
    }
  }

  useEffect(() => {
    void loadBilling();
    void loadTuyaState();
  }, []);

  const s = data?.subscription ?? null;
  const hasExistingSubscription = Boolean(s?.stripeSubscriptionId);

  useEffect(() => {
    if (!s) return;
    setLocks(Math.max(s.entitledLocks, s.activeLocks, 1));
  }, [s?.stripeSubscriptionId, s?.entitledLocks, s?.activeLocks]);

  useEffect(() => {
    if (!s) return;
    setSmartQuantity(
      Math.max(s.entitledSmartProperties, s.activeSmartProperties, 1)
    );
  }, [
    s?.stripeSubscriptionId,
    s?.entitledSmartProperties,
    s?.activeSmartProperties,
  ]);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });

      const json = (await res.json().catch(() => null)) as BillingPreviewResp | null;

      if (!res.ok || !json?.ok) {
        setPreview(null);
        return;
      }

      setPreview(json);
    } catch (e) {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function loadSmartPreview(quantity: number) {
    if (!hasExistingSubscription) {
      setSmartPreview(null);
      return;
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      setSmartPreview(null);
      return;
    }

    try {
      setSmartPreviewLoading(true);

      const res = await fetch(`${API_BASE}/billing/smart/preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });

      const json = (await res.json().catch(() => null)) as BillingPreviewResp | null;

      if (!res.ok || !json?.ok) {
        setSmartPreview(null);
        return;
      }

      setSmartPreview(json);
    } catch (e) {
      setSmartPreview(null);
    } finally {
      setSmartPreviewLoading(false);
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

  useEffect(() => {
    if (!s?.stripeSubscriptionId) {
      setSmartPreview(null);
      return;
    }

    if (!Number.isInteger(smartQuantity) || smartQuantity < 1) {
      setSmartPreview(null);
      return;
    }

    void loadSmartPreview(smartQuantity);
  }, [smartQuantity, s?.stripeSubscriptionId]);

  async function startUpgrade() {
    try {
      setUpgradeLoading(true);
      setErr(null);

      if (hasExistingSubscription) {
        const res = await fetch(`${API_BASE}/billing/locks/quantity`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: locks }),
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locks }),
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
      setErr(String(e?.message ?? e));
    } finally {
      setUpgradeLoading(false);
    }
  }

  async function startSmartUpdate() {
    try {
      setSmartUpdateLoading(true);
      setErr(null);

      const res = await fetch(`${API_BASE}/billing/smart/quantity`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: smartQuantity }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        if (json?.error === "SUBSCRIPTION_BELOW_ACTIVE_SMART_PROPERTIES") {
          throw new Error(
            `You cannot reduce capacity below active smart properties. Active smart properties: ${
              json?.activeSmartProperties ?? "unknown"
            }, requested: ${json?.requestedQuantity ?? smartQuantity}.`
          );
        }

        throw new Error(json?.error || `API ${res.status}`);
      }

      await loadBilling();
      await loadSmartPreview(smartQuantity);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSmartUpdateLoading(false);
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
      setErr(String(e?.message ?? e));
    }
  }

  async function openTuyaSetup() {
    navigate("/integrations/tuya");
  }

  const suggestedLocks = useMemo(() => {
    if (!s) return 1;
    return Math.max(s.entitledLocks, s.activeLocks, 1);
  }, [s]);

  const suggestedSmart = useMemo(() => {
    if (!s) return 1;
    return Math.max(s.entitledSmartProperties, s.activeSmartProperties, 1);
  }, [s]);

  const changeType = useMemo(() => {
    if (!s) return "new";
    if (locks > s.entitledLocks) return "upgrade";
    if (locks < s.entitledLocks) return "downgrade";
    return "same";
  }, [locks, s]);

  const smartChangeType = useMemo(() => {
    if (!s) return "same";
    if (smartQuantity > s.entitledSmartProperties) return "upgrade";
    if (smartQuantity < s.entitledSmartProperties) return "downgrade";
    return "same";
  }, [smartQuantity, s]);

  const primaryButtonLabel = useMemo(() => {
    if (!hasExistingSubscription) return "Start Subscription";
    if (changeType === "upgrade") return "Confirm Upgrade";
    if (changeType === "downgrade") return "Confirm Reduction";
    return "No Changes";
  }, [hasExistingSubscription, changeType]);

  const smartButtonLabel = useMemo(() => {
    if (smartChangeType === "upgrade") return "Confirm Smart Upgrade";
    if (smartChangeType === "downgrade") return "Confirm Smart Reduction";
    return "No Changes";
  }, [smartChangeType]);

  const minAllowed = Math.max(s?.activeLocks ?? 1, 1);
  const smartMinAllowed = Math.max(s?.activeSmartProperties ?? 1, 1);

  const sliderMax = Math.max(
    (s?.entitledLocks ?? 1) + 20,
    (s?.activeLocks ?? 1) + 20,
    25
  );

  const smartSliderMax = Math.max(
    (s?.entitledSmartProperties ?? 1) + 20,
    (s?.activeSmartProperties ?? 1) + 20,
    25
  );

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
            Manage subscription capacity for active locks and smart properties in
            Pin&amp;Go.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              void loadBilling();
              void loadTuyaState();
            }}
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
                Remaining Lock Capacity
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.remainingLocks}
              </div>
            </div>
          </div>

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
                Entitled Smart Properties
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.entitledSmartProperties}
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
                Active Smart Properties
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.activeSmartProperties}
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
                Remaining Smart Capacity
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.remainingSmartProperties}
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
                Smart Usage
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#111827" }}>
                {s.smartUsagePct}%
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
                  Lock Capacity Management
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                  Adjust your total lock capacity. Existing subscriptions update
                  with prorated billing.
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

                <div style={{ display: "grid", gap: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#374151", fontWeight: 700 }}>
                      Selected capacity
                    </div>

                    <div
                      style={{
                        minWidth: 88,
                        height: 38,
                        padding: "0 12px",
                        borderRadius: 999,
                        border: "1px solid #d1d5db",
                        background: "#f9fafb",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 16,
                        fontWeight: 800,
                        color: "#111827",
                      }}
                    >
                      {locks} locks
                    </div>
                  </div>

                  <input
                    id="locks-capacity"
                    type="range"
                    min={minAllowed}
                    max={sliderMax}
                    step={1}
                    value={locks}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setLocks(Number.isFinite(next) ? Math.floor(next) : minAllowed);
                    }}
                    style={{
                      width: "100%",
                      cursor: "pointer",
                      accentColor: "#111827",
                    }}
                  />

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      color: "#6b7280",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>Minimum allowed now: {minAllowed}</span>
                    <span>Suggested start: {suggestedLocks}</span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#374151", fontWeight: 700 }}>
                      Exact number:
                    </div>

                    <input
                      type="number"
                      min={minAllowed}
                      step={1}
                      value={locks}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setLocks(
                          Number.isFinite(next)
                            ? Math.max(minAllowed, Math.floor(next))
                            : minAllowed
                        );
                      }}
                      style={{
                        width: 120,
                        height: 40,
                        borderRadius: 10,
                        border: "1px solid #d1d5db",
                        padding: "0 10px",
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    />

                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      Total desired capacity
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={startUpgrade}
                  disabled={
                    upgradeLoading ||
                    locks < 1 ||
                    (hasExistingSubscription && changeType === "same")
                  }
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid #111827",
                    background:
                      upgradeLoading ||
                      (hasExistingSubscription && changeType === "same")
                        ? "#9ca3af"
                        : "#111827",
                    color: "#ffffff",
                    fontWeight: 800,
                    cursor:
                      upgradeLoading ||
                      (hasExistingSubscription && changeType === "same")
                        ? "not-allowed"
                        : "pointer",
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

                  <div
                    style={{
                      marginTop: 10,
                      marginBottom: 2,
                      padding: 10,
                      borderRadius: 12,
                      border:
                        changeType === "upgrade"
                          ? "1px solid #bfdbfe"
                          : changeType === "downgrade"
                          ? "1px solid #fde68a"
                          : "1px solid #e5e7eb",
                      background:
                        changeType === "upgrade"
                          ? "#eff6ff"
                          : changeType === "downgrade"
                          ? "#fffbeb"
                          : "#f9fafb",
                      color:
                        changeType === "upgrade"
                          ? "#1d4ed8"
                          : changeType === "downgrade"
                          ? "#92400e"
                          : "#374151",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {!hasExistingSubscription
                      ? "This will start your first subscription."
                      : changeType === "upgrade"
                      ? `You are increasing capacity from ${s?.entitledLocks ?? 0} to ${locks} locks.`
                      : changeType === "downgrade"
                      ? `You are reducing capacity from ${s?.entitledLocks ?? 0} to ${locks} locks.`
                      : `Your capacity remains at ${locks} locks.`}
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
                        Stripe preview only. Final invoice may vary slightly based
                        on taxes, credits, or timing.
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      Preview unavailable for the selected quantity.
                    </div>
                  )}
                </div>
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
                  Smart Property Capacity Management
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                  Adjust your total smart property capacity. Existing
                  subscriptions update with prorated billing.
                </div>
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
                  htmlFor="smart-capacity"
                  style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}
                >
                  Total smart properties desired
                </label>

                <div style={{ display: "grid", gap: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#374151", fontWeight: 700 }}>
                      Selected capacity
                    </div>

                    <div
                      style={{
                        minWidth: 88,
                        height: 38,
                        padding: "0 12px",
                        borderRadius: 999,
                        border: "1px solid #d1d5db",
                        background: "#f9fafb",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 16,
                        fontWeight: 800,
                        color: "#111827",
                      }}
                    >
                      {smartQuantity} smart
                    </div>
                  </div>

                  <input
                    id="smart-capacity"
                    type="range"
                    min={smartMinAllowed}
                    max={smartSliderMax}
                    step={1}
                    value={smartQuantity}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setSmartQuantity(
                        Number.isFinite(next) ? Math.floor(next) : smartMinAllowed
                      );
                    }}
                    style={{
                      width: "100%",
                      cursor: "pointer",
                      accentColor: "#111827",
                    }}
                  />

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      color: "#6b7280",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>Minimum allowed now: {smartMinAllowed}</span>
                    <span>Suggested start: {suggestedSmart}</span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#374151", fontWeight: 700 }}>
                      Exact number:
                    </div>

                    <input
                      type="number"
                      min={smartMinAllowed}
                      step={1}
                      value={smartQuantity}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setSmartQuantity(
                          Number.isFinite(next)
                            ? Math.max(smartMinAllowed, Math.floor(next))
                            : smartMinAllowed
                        );
                      }}
                      style={{
                        width: 120,
                        height: 40,
                        borderRadius: 10,
                        border: "1px solid #d1d5db",
                        padding: "0 10px",
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    />

                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      Total desired capacity
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={startSmartUpdate}
                  disabled={
                    smartUpdateLoading ||
                    smartQuantity < 1 ||
                    smartChangeType === "same"
                  }
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid #111827",
                    background:
                      smartUpdateLoading || smartChangeType === "same"
                        ? "#9ca3af"
                        : "#111827",
                    color: "#ffffff",
                    fontWeight: 800,
                    cursor:
                      smartUpdateLoading || smartChangeType === "same"
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  {smartUpdateLoading ? "Saving..." : smartButtonLabel}
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
                    Smart Billing Preview
                  </div>

                  <div
                    style={{
                      marginTop: 10,
                      marginBottom: 2,
                      padding: 10,
                      borderRadius: 12,
                      border:
                        smartChangeType === "upgrade"
                          ? "1px solid #bfdbfe"
                          : smartChangeType === "downgrade"
                          ? "1px solid #fde68a"
                          : "1px solid #e5e7eb",
                      background:
                        smartChangeType === "upgrade"
                          ? "#eff6ff"
                          : smartChangeType === "downgrade"
                          ? "#fffbeb"
                          : "#f9fafb",
                      color:
                        smartChangeType === "upgrade"
                          ? "#1d4ed8"
                          : smartChangeType === "downgrade"
                          ? "#92400e"
                          : "#374151",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {smartChangeType === "upgrade"
                      ? `You are increasing smart capacity from ${
                          s?.entitledSmartProperties ?? 0
                        } to ${smartQuantity} smart properties.`
                      : smartChangeType === "downgrade"
                      ? `You are reducing smart capacity from ${
                          s?.entitledSmartProperties ?? 0
                        } to ${smartQuantity} smart properties.`
                      : `Your smart capacity remains at ${smartQuantity} smart properties.`}
                  </div>

                  {smartPreviewLoading ? (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      Loading preview...
                    </div>
                  ) : smartPreview ? (
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
                          {formatMoney(smartPreview.amountDue, smartPreview.currency)}
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
                          {formatMoney(smartPreview.nextTotal, smartPreview.currency)}
                        </div>
                      </div>

                      {smartPreview.lines?.length ? (
                        <div
                          style={{
                            borderTop: "1px solid #e5e7eb",
                            paddingTop: 10,
                            display: "grid",
                            gap: 8,
                          }}
                        >
                          {smartPreview.lines.map((line, idx) => (
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
                                {formatMoney(line.amount, smartPreview.currency)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        Stripe preview only. Final invoice may vary slightly based
                        on taxes, credits, or timing.
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                      Preview unavailable for the selected quantity.
                    </div>
                  )}
                </div>
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
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
                Smart Features
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                Connect devices and manage smart automation across your
                properties.
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 14,
                padding: 14,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "grid", gap: 6 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 800 }}>Tuya Smart Integration</div>
                  <span style={addonBadgeStyle(tuyaState !== "locked")}>
                    {tuyaLoading
                      ? "Checking..."
                      : tuyaState === "connected"
                      ? "Connected"
                      : tuyaState === "pending_onboarding"
                      ? "Pending onboarding"
                      : "Locked"}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  Connect IoT devices like AC, lights, curtains and other smart
                  devices to automation.
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {tuyaState === "connected" ? (
                  <button
                    onClick={() => navigate("/integrations/tuya")}
                    style={{
                      height: 40,
                      padding: "0 14px",
                      borderRadius: 10,
                      border: "1px solid #111827",
                      background: "#111827",
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Manage Tuya
                  </button>
                ) : tuyaState === "pending_onboarding" ? (
                  <button
                    onClick={() => navigate("/integrations/tuya")}
                    style={{
                      height: 40,
                      padding: "0 14px",
                      borderRadius: 10,
                      border: "1px solid #111827",
                      background: "#111827",
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Continue Setup
                  </button>
                ) : (
                  <button
                    onClick={openTuyaSetup}
                    style={{
                      height: 40,
                      padding: "0 14px",
                      borderRadius: 10,
                      border: "1px solid #111827",
                      background: "#111827",
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Open Tuya Setup
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}