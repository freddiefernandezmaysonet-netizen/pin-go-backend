import { useCallback, useEffect, useMemo, useState } from "react";

type TuyaState = "locked" | "pending_onboarding" | "connected";

type TuyaAccess = {
  state: TuyaState;
  hasEntitlement?: boolean;
  hasTuyaUid?: boolean;
};

type Device = {
  id?: string;
  name?: string;
  deviceId?: string;
  productName?: string;
  online?: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

function getOrgId() {
  return (
    localStorage.getItem("organizationId") ||
    localStorage.getItem("orgId") ||
    ""
  );
}

export default function TuyaIntegrationPremiumPage() {
  const orgId = useMemo(() => getOrgId(), []);

  const [state, setState] = useState<TuyaState>("locked");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const res = await fetch(
        `${API_BASE}/api/org/tuya/access/status?organizationId=${orgId}`,
        { credentials: "include" }
      );

      const json = await res.json();

      const access: TuyaAccess = json.tuya;
      setState(access?.state ?? "locked");

      if (access?.state === "connected") {
        try {
          const d = await fetch(
            `${API_BASE}/api/org/tuya/devices?organizationId=${orgId}`,
            { credentials: "include" }
          );
          const dj = await d.json();
          setDevices(dj.items ?? dj.devices ?? []);
        } catch {
          setDevices([]);
        }
      } else {
        setDevices([]);
      }
    } catch {
      setState("locked");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCheckout = async () => {
    setCheckoutLoading(true);

    try {
      const res = await fetch(
        `${API_BASE}/api/org/tuya/billing/checkout-session`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId }),
        }
      );

      const json = await res.json();

      if (json?.checkout?.url) {
        window.location.href = json.checkout.url;
      }
    } finally {
      setCheckoutLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24 }}>Loading Tuya...</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Tuya Premium</h1>

      {/* LOCKED */}
      {state === "locked" && (
        <div style={{ marginTop: 20 }}>
          <h2>🔒 Locked</h2>
          <p>Tuya requiere activación premium.</p>

          <button onClick={openCheckout} disabled={checkoutLoading}>
            {checkoutLoading ? "Opening..." : "Unlock Tuya"}
          </button>
        </div>
      )}

      {/* PENDING */}
      {state === "pending_onboarding" && (
        <div style={{ marginTop: 20 }}>
          <h2>⏳ Pending onboarding</h2>
          <p>Tuya está activo pero requiere configuración asistida.</p>

          <a href="mailto:support@pingo.com">
            Schedule onboarding
          </a>
        </div>
      )}

      {/* CONNECTED */}
      {state === "connected" && (
        <div style={{ marginTop: 20 }}>
          <h2>✅ Connected</h2>

          <button onClick={load}>Refresh</button>

          <div style={{ marginTop: 16 }}>
            {devices.length === 0 ? (
              <p>No devices</p>
            ) : (
              <ul>
                {devices.map((d, i) => (
                  <li key={d.id ?? i}>
                    {d.name ?? "Device"} — {d.online ? "Online" : "Offline"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}