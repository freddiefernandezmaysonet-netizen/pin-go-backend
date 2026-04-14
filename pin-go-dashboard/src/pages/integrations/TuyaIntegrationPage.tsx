import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type TuyaStatusResponse = {
  ok: boolean;
  linked?: boolean;
  uid?: string | null;
  status?: string | null;
  error?: string;
};

type TuyaDeviceRow = {
  id?: string;
  name?: string;
  category?: string | null;
  online?: boolean;
  externalDeviceId?: string;
  deviceName?: string;
  deviceCategory?: string | null;
};

type TuyaDevicesResponse = {
  ok: boolean;
  count?: number;
  items?: TuyaDeviceRow[];
  error?: string;
};

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

function statusBadge(linked: boolean, status?: string | null) {
  const label = linked ? status || "LINKED" : "NOT LINKED";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: linked ? "#ecfdf5" : "#f3f4f6",
        color: linked ? "#065f46" : "#4b5563",
        border: linked ? "1px solid #a7f3d0" : "1px solid #e5e7eb",
      }}
    >
      {label}
    </span>
  );
}

function normalizeDeviceName(device: TuyaDeviceRow) {
  return (
    String(device.deviceName ?? "").trim() ||
    String(device.name ?? "").trim() ||
    "Unnamed device"
  );
}

function normalizeDeviceCategory(device: TuyaDeviceRow) {
  return (
    String(device.deviceCategory ?? "").trim() ||
    String(device.category ?? "").trim() ||
    "Unknown category"
  );
}

export default function TuyaIntegrationPage() {
  const [uidInput, setUidInput] = useState("");
  const [linked, setLinked] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [currentUid, setCurrentUid] = useState<string | null>(null);

  const [devices, setDevices] = useState<TuyaDeviceRow[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [error, setError] = useState("");
  const [devicesError, setDevicesError] = useState("");
  const [success, setSuccess] = useState("");

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError("");
    setSuccess("");

    try {
      const resp = await fetch(`${API_BASE}/api/org/tuya/status`, {
        credentials: "include",
      });

      const data = (await resp.json()) as TuyaStatusResponse;

      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to load Tuya status");
      }

      setLinked(Boolean(data.linked));
      setStatus(data.status ?? null);
      setCurrentUid(data.uid ?? null);
      setUidInput(String(data.uid ?? ""));
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setLinked(false);
      setStatus(null);
      setCurrentUid(null);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDevicesError("");

    try {
      const resp = await fetch(`${API_BASE}/api/org/tuya/devices`, {
        credentials: "include",
      });

      const data = (await resp.json()) as TuyaDevicesResponse;

      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to load Tuya devices");
      }

      setDevices(Array.isArray(data.items) ? data.items : []);
    } catch (err: any) {
      setDevices([]);
      setDevicesError(String(err?.message ?? err));
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (linked) {
      void loadDevices();
    } else {
      setDevices([]);
      setDevicesError("");
    }
  }, [linked, loadDevices]);

  async function handleConnect() {
    try {
      setSaving(true);
      setError("");
      setSuccess("");

      const uid = uidInput.trim();
      if (!uid) {
        throw new Error("UID_REQUIRED");
      }

      const resp = await fetch(`${API_BASE}/api/org/tuya/link`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });

      const data = await resp.json();

      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to link Tuya");
      }

      setSuccess("Tuya connected successfully.");
      await loadStatus();
      await loadDevices();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    try {
      setDisconnecting(true);
      setError("");
      setSuccess("");

      const resp = await fetch(`${API_BASE}/api/org/tuya/unlink`, {
        method: "POST",
        credentials: "include",
      });

      const data = await resp.json();

      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to unlink Tuya");
      }

      setSuccess("Tuya disconnected.");
      await loadStatus();
      setDevices([]);
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setDisconnecting(false);
    }
  }

  const onlineCount = useMemo(
    () => devices.filter((d) => d.online === true).length,
    [devices]
  );

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <Link to="/overview" style={{ color: "#2563eb", textDecoration: "none" }}>
          ← Back to overview
        </Link>
      </div>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: 0 }}>Tuya Integration</h1>
        <p style={{ color: "#666", marginTop: 8 }}>
          Connect the Tuya UID for this organization and sync devices into the dashboard.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        }}
      >
        <Stat title="Connection" value={linked ? "Connected" : "Not connected"} />
        <Stat title="Devices" value={devices.length} />
        <Stat title="Online" value={onlineCount} />
      </div>

      <SectionCard
        title="Connection Status"
        right={loadingStatus ? null : statusBadge(linked, status)}
      >
        {error ? (
          <div
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              padding: 12,
              borderRadius: 12,
              color: "#991b1b",
            }}
          >
            <b>Error:</b> {error}
          </div>
        ) : null}

        {success ? (
          <div
            style={{
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              padding: 12,
              borderRadius: 12,
              color: "#166534",
            }}
          >
            {success}
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 8 }}>
          <label
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#374151",
            }}
          >
            Tuya UID
          </label>

          <input
            value={uidInput}
            onChange={(e) => setUidInput(e.target.value)}
            placeholder="Paste the Tuya UID for this organization"
            style={{
              height: 42,
              borderRadius: 12,
              border: "1px solid #d1d5db",
              padding: "0 12px",
              background: "#fff",
            }}
          />

          <div style={{ fontSize: 12, color: "#6b7280" }}>
            Current UID: {currentUid ? currentUid : "Not linked"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={handleConnect}
            disabled={saving}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 12,
              border: "1px solid #111827",
              background: saving ? "#9ca3af" : "#111827",
              color: "#fff",
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Connecting..." : linked ? "Update Tuya UID" : "Connect Tuya"}
          </button>

          <button
            onClick={handleDisconnect}
            disabled={!linked || disconnecting}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 12,
              border: "1px solid #d1d5db",
              background: "#fff",
              color: !linked || disconnecting ? "#9ca3af" : "#111827",
              fontWeight: 700,
              cursor: !linked || disconnecting ? "not-allowed" : "pointer",
            }}
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </button>

          <button
            onClick={() => void loadDevices()}
            disabled={!linked || loadingDevices}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 12,
              border: "1px solid #d1d5db",
              background: "#fff",
              color: !linked || loadingDevices ? "#9ca3af" : "#111827",
              fontWeight: 700,
              cursor: !linked || loadingDevices ? "not-allowed" : "pointer",
            }}
          >
            {loadingDevices ? "Refreshing..." : "Refresh Devices"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={`Organization Devices (${devices.length})`}>
        {devicesError ? (
          <div
            style={{
              border: "1px solid #fecaca",
              background: "#fef2f2",
              padding: 12,
              borderRadius: 12,
              color: "#991b1b",
            }}
          >
            <b>Error:</b> {devicesError}
          </div>
        ) : loadingDevices ? (
          <div style={{ color: "#6b7280" }}>Loading devices...</div>
        ) : !linked ? (
          <div
            style={{
              borderRadius: 12,
              padding: 16,
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              color: "#6b7280",
            }}
          >
            Connect Tuya first to view organization devices.
          </div>
        ) : devices.length === 0 ? (
          <div
            style={{
              borderRadius: 12,
              padding: 16,
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              color: "#6b7280",
            }}
          >
            No devices found for the linked UID.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {devices.map((device, index) => (
              <div
                key={String(device.id ?? device.externalDeviceId ?? index)}
                style={{
                  border: "1px solid #f3f4f6",
                  borderRadius: 14,
                  padding: 12,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontWeight: 700, color: "#111827" }}>
                    {normalizeDeviceName(device)}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    {normalizeDeviceCategory(device)}
                  </div>
                  <div style={{ fontSize: 12, color: "#9ca3af" }}>
                    ID: {String(device.id ?? device.externalDeviceId ?? "—")}
                  </div>
                </div>

                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 8px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 700,
                    border: "1px solid #e5e7eb",
                    background: device.online ? "#ecfdf5" : "#f3f4f6",
                    color: device.online ? "#065f46" : "#4b5563",
                    whiteSpace: "nowrap",
                  }}
                >
                  {device.online ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}