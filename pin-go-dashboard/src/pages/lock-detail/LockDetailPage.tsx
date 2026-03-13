import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { getOrganizationId } from "../../lib/getOrganizationId";

type LockRow = {
  id: string;
  ttlockLockId: number;
  name: string | null;
  isActive: boolean;
  property: { id: string; name: string } | null;
  battery?: number | null;
  batteryFresh?: boolean;
  gatewayName?: string | null;
  gatewayId?: number | null;
  gatewayOnline?: boolean | null;
  gatewayFresh?: boolean;
  updatedAt?: string | null;
};

type LocksResp = {
  items?: LockRow[];
  error?: string;
};

type SwapResp = {
  ok: boolean;
  error?: string;
  swapped?: boolean;
  propertyId?: string;
  oldTtlockLockId?: number;
  newTtlockLockId?: number;
  lock?: {
    id: string;
    ttlockLockId: number;
    ttlockLockName?: string | null;
    propertyId?: string;
    isActive?: boolean;
  };
};

type TtlockSelectableLock = {
  ttlockLockId: number;
  name: string | null;
  registered: boolean;
  availableForActivation: boolean;
  availableForSwap: boolean;
  existingLock: {
    id: string;
    ttlockLockId: number;
    name: string | null;
    isActive: boolean;
    propertyId: string;
    property: { id: string; name: string } | null;
  } | null;
};

type TtlockInventoryResp = {
  ok: boolean;
  error?: string;
  organizationId?: string;
  propertyId?: string | null;
  totalFromTtlock?: number;
  locks?: TtlockSelectableLock[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";


function Stat({
  label,
  value,
  helper,
}: {
  label: string;
  value: string | number;
  helper?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: 18,
        background: "#fff",
        minHeight: 110,
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
        {value}
      </div>
      {helper ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          {helper}
        </div>
      ) : null}
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
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>{title}</h3>
        {right}
      </div>

      {children}
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid #f3f4f6",
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 14, color: "#111827", fontWeight: 500 }}>
        {value}
      </div>
    </div>
  );
}

function formatUpdatedAt(value?: string | null) {
  if (!value) return "No recent sync";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "No recent sync";

  return d.toLocaleString();
}

function normalizeError(error?: string) {
  switch (error) {
    case "SWAP_OUT_LOCK_NOT_FOUND":
      return "The current lock was not found for swap.";
    case "SWAP_OUT_LOCK_NOT_ACTIVE":
      return "The current lock is not active and cannot be swapped.";
    case "SWAP_OUT_LOCK_OTHER_ORG":
      return "The current lock belongs to another organization.";
    case "SWAP_OUT_LOCK_NOT_IN_PROPERTY":
      return "The current lock does not belong to this property.";
    case "NEW_LOCK_BELONGS_TO_ANOTHER_ORG":
      return "The selected TTLock device belongs to another organization.";
    case "OLD_AND_NEW_LOCK_CANNOT_MATCH":
      return "The new TTLock device must be different from the current lock.";
    case "PROPERTY_NOT_IN_ORG":
      return "The property does not belong to your organization.";
    case "PROPERTY_NOT_FOUND_FOR_ORG":
      return "The property was not found for your organization.";
    case "TTLOCK_NOT_CONNECTED":
      return "TTLock is not connected for this organization.";
    case "ORG_CONTEXT_MISSING":
      return "Organization context is missing.";
    case "ORGANIZATION_ID_REQUIRED":
      return "Organization id is required.";
    case "ORG_NOT_FOUND":
      return "Organization was not found.";
    case "MISSING_SWAP_FIELDS":
      return "Missing required swap fields.";
    case "INVALID_TTLOCK_LOCK_ID":
      return "Invalid TTLock lock id.";
    default:
      return error ?? "Operation failed.";
  }
}

function ReadonlyField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, color: "#6b7280" }}>{label}</span>
      <div
        style={{
          minHeight: 40,
          borderRadius: 10,
          border: "1px solid #d1d5db",
          padding: "10px 12px",
          background: "#f9fafb",
          color: "#111827",
          fontSize: 14,
          display: "flex",
          alignItems: "center",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return {
    height: 40,
    padding: "0 16px",
    borderRadius: 10,
    border: "1px solid #111827",
    background: disabled ? "#e5e7eb" : "#111827",
    color: disabled ? "#6b7280" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
  };
}

export function LockDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [lock, setLock] = useState<LockRow | null>(null);
  const [loading, setLoading] = useState(false);

  const [availableLocks, setAvailableLocks] = useState<TtlockSelectableLock[]>([]);
  const [availableLocksLoading, setAvailableLocksLoading] = useState(false);
  const [availableLocksError, setAvailableLocksError] = useState<string | null>(null);
  const [inventoryMessage, setInventoryMessage] = useState<string | null>(null);

  const [selectedTtlockLockId, setSelectedTtlockLockId] = useState("");
  const [newTtlockLockName, setNewTtlockLockName] = useState("");
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapSuccess, setSwapSuccess] = useState<string | null>(null);

  const loadLock = useCallback(async () => {
    if (!id) {
      setLock(null);
      return;
    }

    setLoading(true);

    try {
      const r = await fetch(`${API_BASE}/api/dashboard/locks?page=1&pageSize=50`, {
        credentials: "include",
      });

      const data: LocksResp = await r.json();

      if (!r.ok) {
        setLock(null);
        return;
      }

      const found = data.items?.find((l) => l.id === id) ?? null;
      setLock(found);
    } catch {
      setLock(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadAvailableTtlockLocks = useCallback(
    async (propertyId: string, currentTtlockLockId?: number) => {
      setAvailableLocksLoading(true);
      setAvailableLocksError(null);
      setInventoryMessage(null);

      try {
        const organizationId = getOrganizationId();

        if (!organizationId) {
          setAvailableLocks([]);
          setAvailableLocksError("Organization id is required.");
          return;
        }

        const qs = new URLSearchParams({
          propertyId,
          organizationId,
        }).toString();

        const r = await fetch(`${API_BASE}/api/org/ttlock/inventory?${qs}`, {
          credentials: "include",
        });

        const data: TtlockInventoryResp = await r.json();

        if (!r.ok || !data.ok) {
          setAvailableLocks([]);
          setAvailableLocksError(normalizeError(data.error));
          return;
        }

        const filtered = (data.locks ?? []).filter(
          (item) => item.availableForSwap && item.ttlockLockId !== currentTtlockLockId
        );

        setAvailableLocks(filtered);
        setInventoryMessage(
          `Inventory pulled from TTLock. Total remote locks: ${data.totalFromTtlock ?? 0}.`
        );
      } catch (err: any) {
        setAvailableLocks([]);
        setAvailableLocksError(
          String(err?.message ?? err ?? "Unable to load TTLock inventory.")
        );
      } finally {
        setAvailableLocksLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadLock();
  }, [loadLock]);

  useEffect(() => {
    setSelectedTtlockLockId("");
    setNewTtlockLockName("");
    setSwapError(null);
    setSwapSuccess(null);
    setInventoryMessage(null);

    if (!lock?.property?.id) return;
    void loadAvailableTtlockLocks(lock.property.id, lock.ttlockLockId);
  }, [lock?.id, lock?.property?.id, lock?.ttlockLockId, loadAvailableTtlockLocks]);

  const batteryValue = useMemo(() => {
    if (lock?.battery == null) return "—";
    return `${lock.battery}%`;
  }, [lock?.battery]);

  const batteryHelper = useMemo(() => {
    if (!lock) return "";
    if (lock.battery == null) return "Battery data not available yet";
    if (lock.batteryFresh === false) return "Battery cache not refreshed yet";
    return lock.battery <= 20
      ? "Low battery attention recommended"
      : "Last known battery level";
  }, [lock]);

  const gatewayValue = useMemo(() => {
    if (!lock) return "—";
    if (lock.gatewayName) return lock.gatewayName;
    if (lock.gatewayId != null) return `Gateway #${lock.gatewayId}`;
    return "—";
  }, [lock]);

  const gatewayHelper = useMemo(() => {
    if (!lock) return "";
    if (lock.gatewayId == null && !lock.gatewayName) {
      return "Gateway data not available yet";
    }
    if (lock.gatewayFresh === false) {
      return "Gateway cache not refreshed yet";
    }
    if (lock.gatewayOnline == null) {
      return "Gateway status not available yet";
    }
    return lock.gatewayOnline ? "Online" : "Offline";
  }, [lock]);

  const batteryDetailValue = useMemo(() => {
    if (!lock) return "—";
    if (lock.battery == null) return "—";
    return lock.batteryFresh === false ? `${lock.battery}% (stale)` : `${lock.battery}%`;
  }, [lock]);

  const gatewayDetailValue = useMemo(() => {
    if (!lock) return "—";
    const base = lock.gatewayName
      ? lock.gatewayName
      : lock.gatewayId != null
      ? `Gateway #${lock.gatewayId}`
      : "—";

    if (base === "—") return base;
    return lock.gatewayFresh === false ? `${base} (stale)` : base;
  }, [lock]);

  const selectedLockOption = useMemo(() => {
    const selectedId = Number(selectedTtlockLockId);
    if (!Number.isFinite(selectedId) || selectedId <= 0) return null;
    return availableLocks.find((item) => item.ttlockLockId === selectedId) ?? null;
  }, [availableLocks, selectedTtlockLockId]);

  useEffect(() => {
    if (!selectedLockOption) {
      setNewTtlockLockName("");
      return;
    }

    setNewTtlockLockName(selectedLockOption.name ?? "");
  }, [selectedLockOption]);

  const selectedLockLabel = useMemo(() => {
    if (!selectedLockOption) return "No TTLock device selected";
    return `${selectedLockOption.name ?? "TTLock Lock"} — ${selectedLockOption.ttlockLockId}`;
  }, [selectedLockOption]);

  async function handleRefreshInventory() {
    if (!lock?.property?.id) {
      setAvailableLocksError("This lock does not have a valid property assigned.");
      setInventoryMessage(null);
      return;
    }

    await loadAvailableTtlockLocks(lock.property.id, lock.ttlockLockId);
  }

  async function handleSwapSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!lock?.property?.id) {
      setSwapError("This lock does not have a valid property assigned.");
      setSwapSuccess(null);
      return;
    }

    const parsedNewId = Number(selectedTtlockLockId.trim());

    if (!Number.isFinite(parsedNewId) || parsedNewId <= 0) {
      setSwapError("Select a TTLock device from the available list.");
      setSwapSuccess(null);
      return;
    }

    if (parsedNewId === lock.ttlockLockId) {
      setSwapError("The new TTLock device must be different from the current lock.");
      setSwapSuccess(null);
      return;
    }

    const organizationId = getOrganizationId();

    if (!organizationId) {
      setSwapError("Organization id is required.");
      setSwapSuccess(null);
      return;
    }

    setSwapLoading(true);
    setSwapError(null);
    setSwapSuccess(null);

    try {
      const r = await fetch(`${API_BASE}/api/org/locks/swap`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
          propertyId: lock.property.id,
          oldTtlockLockId: lock.ttlockLockId,
          newTtlockLockId: parsedNewId,
          newTtlockLockName: newTtlockLockName.trim() || undefined,
        }),
      });

      const data: SwapResp = await r.json();

      if (!r.ok || !data.ok) {
        setSwapError(normalizeError(data.error));
        setSwapSuccess(null);
        return;
      }

      setSwapSuccess("Lock swapped successfully.");
      setSelectedTtlockLockId("");
      setNewTtlockLockName("");

      await loadLock();

      if (data.lock?.id) {
        navigate(`/locks/${data.lock.id}`);
        return;
      }

      await loadAvailableTtlockLocks(lock.property.id, parsedNewId);
    } catch (err: any) {
      setSwapError(String(err?.message ?? err ?? "Swap failed."));
      setSwapSuccess(null);
    } finally {
      setSwapLoading(false);
    }
  }

  if (loading) return <div>Loading lock...</div>;
  if (!lock) return <div>Lock not found.</div>;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Link to="/locks">← Back to locks</Link>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 8 }}>
          {lock.name ?? "TTLock Lock"}
        </h1>
        <p style={{ color: "#666", margin: 0 }}>
          Property: {lock.property?.name ?? "—"}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <Stat label="TTLock ID" value={lock.ttlockLockId} />
        <Stat
          label="Status"
          value={lock.isActive ? "ACTIVE" : "DISABLED"}
          helper={
            lock.isActive
              ? "Lock available for operations"
              : "Lock currently not active"
          }
        />
        <Stat label="Battery" value={batteryValue} helper={batteryHelper} />
        <Stat label="Gateway" value={gatewayValue} helper={gatewayHelper} />
      </div>

      <SectionCard title="Lock Details">
        <InfoRow label="Lock Name" value={lock.name ?? "TTLock Lock"} />
        <InfoRow label="Property" value={lock.property?.name ?? "—"} />
        <InfoRow label="TTLock Lock ID" value={lock.ttlockLockId} />
        <InfoRow label="Battery" value={batteryDetailValue} />
        <InfoRow
          label="Battery Fresh"
          value={lock.batteryFresh == null ? "—" : lock.batteryFresh ? "YES" : "NO"}
        />
        <InfoRow label="Gateway" value={gatewayDetailValue} />
        <InfoRow
          label="Gateway Fresh"
          value={lock.gatewayFresh == null ? "—" : lock.gatewayFresh ? "YES" : "NO"}
        />
        <InfoRow
          label="Gateway Status"
          value={
            lock.gatewayOnline == null
              ? "—"
              : lock.gatewayOnline
              ? "ONLINE"
              : "OFFLINE"
          }
        />
        <InfoRow label="Last Sync" value={formatUpdatedAt(lock.updatedAt)} />
      </SectionCard>

      <SectionCard title="Lock Operations">
        <div style={{ display: "grid", gap: 16 }}>
          <form
            onSubmit={handleSwapSubmit}
            style={{
              border: "1px solid #f3f4f6",
              borderRadius: 14,
              padding: 14,
              background: "#fafafa",
              display: "grid",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Swap Lock</div>
              <div style={{ fontSize: 14, color: "#6b7280" }}>
                Replace this active lock with another TTLock device for the same
                property using the organization inventory.
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <ReadonlyField
                label="Current Lock to Deactivate"
                value={`${lock.name ?? "TTLock Lock"} — ${lock.ttlockLockId}`}
              />

              <ReadonlyField label="Property" value={lock.property?.name ?? "—"} />
            </div>

            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <button
                type="button"
                onClick={handleRefreshInventory}
                disabled={swapLoading || availableLocksLoading}
                style={buttonStyle(swapLoading || availableLocksLoading)}
              >
                {availableLocksLoading ? "Refreshing..." : "Refresh TTLock Inventory"}
              </button>

              <span style={{ fontSize: 13, color: "#6b7280" }}>
                Pull neutral TTLock inventory for this organization without assigning locks to a property.
              </span>
            </div>

            {inventoryMessage ? (
              <div
                style={{
                  borderRadius: 10,
                  padding: 12,
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  color: "#1d4ed8",
                  fontSize: 14,
                }}
              >
                {inventoryMessage}
              </div>
            ) : null}

            {availableLocksError ? (
              <div
                style={{
                  borderRadius: 10,
                  padding: 12,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: 14,
                }}
              >
                {availableLocksError}
              </div>
            ) : null}

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 13, color: "#6b7280" }}>
                  Available TTLock Device
                </span>
                <select
                  value={selectedTtlockLockId}
                  onChange={(e) => setSelectedTtlockLockId(e.target.value)}
                  disabled={swapLoading || availableLocksLoading}
                  style={{
                    height: 40,
                    borderRadius: 10,
                    border: "1px solid #d1d5db",
                    padding: "0 12px",
                    background: "#fff",
                  }}
                >
                  <option value="">
                    {availableLocksLoading
                      ? "Loading TTLock inventory..."
                      : availableLocks.length > 0
                      ? "Select a TTLock device"
                      : "No TTLock devices available"}
                  </option>

                  {availableLocks.map((item) => (
                    <option key={item.ttlockLockId} value={String(item.ttlockLockId)}>
                      {(item.name ?? "TTLock Lock") + " — " + item.ttlockLockId}
                    </option>
                  ))}
                </select>
              </label>

              <ReadonlyField label="Selected New Lock" value={selectedLockLabel} />
            </div>

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <ReadonlyField
                label="Selected TTLock ID"
                value={selectedTtlockLockId || "—"}
              />

              <ReadonlyField
                label="Selected Lock Name"
                value={newTtlockLockName || "—"}
              />
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: 12,
                background: "#fff",
                fontSize: 14,
                color: "#374151",
              }}
            >
              <strong>Swap summary:</strong>{" "}
              {lock.name ?? "Current Lock"} ({lock.ttlockLockId}) →{" "}
              {selectedTtlockLockId
                ? `${newTtlockLockName || "TTLock Lock"} (${selectedTtlockLockId})`
                : "Select a TTLock device"}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <button
                type="submit"
                disabled={
                  swapLoading ||
                  !lock.isActive ||
                  !selectedTtlockLockId ||
                  availableLocksLoading
                }
                style={buttonStyle(
                  swapLoading ||
                    !lock.isActive ||
                    !selectedTtlockLockId ||
                    availableLocksLoading
                )}
              >
                {swapLoading ? "Swapping..." : "Execute Swap"}
              </button>

              {!lock.isActive ? (
                <span style={{ fontSize: 13, color: "#b45309" }}>
                  Only active locks can be swapped.
                </span>
              ) : null}
            </div>

            {swapError ? (
              <div
                style={{
                  borderRadius: 10,
                  padding: 12,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: 14,
                }}
              >
                {swapError}
              </div>
            ) : null}

            {swapSuccess ? (
              <div
                style={{
                  borderRadius: 10,
                  padding: 12,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  color: "#166534",
                  fontSize: 14,
                }}
              >
                {swapSuccess}
              </div>
            ) : null}
          </form>

          <div
            style={{
              border: "1px solid #f3f4f6",
              borderRadius: 14,
              padding: 14,
              background: "#fafafa",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Operational Safety
            </div>
            <div style={{ fontSize: 14, color: "#6b7280" }}>
              Swap now uses TTLock inventory pulled at organization level, while assignment happens only when executing the swap inside the selected property.
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Lock Activity">
        <p style={{ color: "#6b7280", margin: 0 }}>
          Next step: show passcodes, NFC assignments and recent hardware events.
        </p>
      </SectionCard>
    </div>
  );
}