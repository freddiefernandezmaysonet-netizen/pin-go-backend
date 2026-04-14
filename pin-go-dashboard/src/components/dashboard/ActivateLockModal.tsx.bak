import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

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

type ActivateResp = {
  ok: boolean;
  error?: string;
  created?: boolean;
  reused?: boolean;
  slotConsumed?: boolean;
  entitledLocks?: number;
  usedLocks?: number;
  status?: string;
  lock?: {
    id: string;
    ttlockLockId: number;
    ttlockLockName?: string | null;
    propertyId?: string;
    isActive?: boolean;
  };
};

function normalizeError(error?: string) {
  switch (error) {
    case "TTLOCK_NOT_CONNECTED":
      return "TTLock is not connected for this organization.";
    case "PROPERTY_NOT_FOUND":
      return "The property was not found.";
    case "PROPERTY_NOT_IN_ORG":
      return "The property does not belong to your organization.";
    case "LOCK_BELONGS_TO_ANOTHER_ORG":
      return "This lock belongs to another organization.";
    case "LOCK_LIMIT_REACHED":
      return "Lock limit reached for the current plan.";
    case "SUBSCRIPTION_INACTIVE":
      return "Subscription is inactive.";
    case "MISSING_FIELDS":
      return "Missing required fields.";
    case "INVALID_TTLOCK_LOCK_ID":
      return "Invalid TTLock lock id.";
    case "ORG_CONTEXT_MISSING":
      return "Organization context is missing.";
    default:
      return error ?? "Unable to complete activation.";
  }
}

export function ActivateLockModal({
  open,
  propertyId,
  propertyName,
  onClose,
  onActivated,
}: {
  open: boolean;
  propertyId: string;
  propertyName: string;
  onClose: () => void;
  onActivated: () => Promise<void> | void;
}) {
  const { user } = useAuth();
  const organizationId = user?.orgId ?? "";

  const [locks, setLocks] = useState<TtlockSelectableLock[]>([]);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedTtlockLockId, setSelectedTtlockLockId] = useState("");

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setErr(null);
    setSuccess(null);
    setSelectedTtlockLockId("");

    fetch(
      `${API_BASE}/api/org/ttlock/inventory?propertyId=${encodeURIComponent(
        propertyId
      )}&organizationId=${encodeURIComponent(organizationId)}`,
      {
        credentials: "include",
      }
    )
      .then(async (res) => {
        const data: TtlockInventoryResp = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(normalizeError(data.error));
        }

        const available = (data.locks ?? []).filter((item) => item.availableForActivation);
        setLocks(available);
      })
      .catch((e) => {
        console.error("ACTIVATE LOCK INVENTORY ERROR", e);
        setLocks([]);
        setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, [open, propertyId, organizationId]);

  const selectedLock = useMemo(() => {
    const parsed = Number(selectedTtlockLockId);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return locks.find((x) => x.ttlockLockId === parsed) ?? null;
  }, [locks, selectedTtlockLockId]);

  async function handleActivate() {
    const parsed = Number(selectedTtlockLockId);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      setErr("Select a TTLock device first.");
      setSuccess(null);
      return;
    }

    setActivating(true);
    setErr(null);
    setSuccess(null);

    try {
      const r = await fetch(`${API_BASE}/api/org/locks/activate`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
          propertyId,
          ttlockLockId: parsed,
          ttlockLockName: selectedLock?.name ?? undefined,
        }),
      });

      const data: ActivateResp = await r.json();

      if (!r.ok || !data.ok) {
        setErr(normalizeError(data.error));
        return;
      }

      setSuccess(
        data.created
          ? `Lock activated successfully. ${
              data.slotConsumed ? "1 slot consumed from plan." : ""
            }`
          : data.reused
          ? "Existing lock reused successfully for this property."
          : "Lock activated successfully."
      );

      await Promise.resolve(onActivated());
    } catch (e: any) {
      console.error("ACTIVATE LOCK ERROR", e);
      setErr(String(e?.message ?? e ?? "Activation failed."));
    } finally {
      setActivating(false);
    }
  }

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17,24,39,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          borderRadius: 20,
          background: "#fff",
          border: "1px solid #e5e7eb",
          boxShadow: "0 20px 50px rgba(0,0,0,0.18)",
          padding: 20,
          display: "grid",
          gap: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "start",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>
              Add Lock
            </div>
            <div style={{ fontSize: 14, color: "#6b7280", marginTop: 6 }}>
              Activate a TTLock device for <b>{propertyName}</b>.
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              border: "1px solid #e5e7eb",
              background: "#fff",
              borderRadius: 10,
              padding: "8px 12px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>

        <div
          style={{
            border: "1px solid #f3f4f6",
            borderRadius: 14,
            padding: 14,
            background: "#fafafa",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, color: "#6b7280" }}>Property</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>
            {propertyName}
          </div>
        </div>

        {loading ? (
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 14,
              padding: 16,
              background: "#fff",
              color: "#6b7280",
            }}
          >
            Loading TTLock inventory...
          </div>
        ) : (
          <label style={{ display: "grid", gap: 8 }}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>
              Available TTLock Device
            </span>

            <select
              value={selectedTtlockLockId}
              onChange={(e) => setSelectedTtlockLockId(e.target.value)}
              disabled={activating}
              style={{
                height: 42,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 12px",
                background: "#fff",
              }}
            >
              <option value="">
                {locks.length > 0 ? "Select a TTLock device" : "No TTLock devices available"}
              </option>

              {locks.map((l) => (
                <option key={l.ttlockLockId} value={String(l.ttlockLockId)}>
                  {(l.name ?? "TTLock Lock") + " — " + l.ttlockLockId}
                </option>
              ))}
            </select>
          </label>
        )}

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 14,
            background: "#fff",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, color: "#6b7280" }}>Selection Summary</div>
          <div style={{ fontSize: 15, color: "#111827", fontWeight: 600 }}>
            {selectedLock
              ? `${selectedLock.name ?? "TTLock Lock"} — ${selectedLock.ttlockLockId}`
              : "No TTLock device selected"}
          </div>
        </div>

        {err ? (
          <div
            style={{
              borderRadius: 12,
              padding: 12,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: 14,
            }}
          >
            {err}
          </div>
        ) : null}

        {success ? (
          <div
            style={{
              borderRadius: 12,
              padding: 12,
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              color: "#166534",
              fontSize: 14,
            }}
          >
            {success}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onClose}
            disabled={activating}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 12,
              border: "1px solid #d1d5db",
              background: "#fff",
              color: "#374151",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleActivate}
            disabled={activating || !selectedTtlockLockId || loading}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 12,
              border: "1px solid #111827",
              background:
                activating || !selectedTtlockLockId || loading ? "#e5e7eb" : "#111827",
              color:
                activating || !selectedTtlockLockId || loading ? "#6b7280" : "#fff",
              cursor:
                activating || !selectedTtlockLockId || loading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {activating ? "Activating..." : "Activate Lock"}
          </button>
        </div>
      </div>
    </div>
  );
}