import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type PropertyRow = {
  id: string;
  name: string;
};

type LockRow = {
  id: string;
  ttlockLockId: number;
  name: string | null;
  isActive: boolean;
  property: { id: string; name: string } | null;
};

type NfcCardRow = {
  id: string;
  ttlockCardId: number;
  label: string | null;
  status: string;
  createdAt: string;
};

type PropertiesResp = {
  items?: PropertyRow[];
  error?: string;
};

type LocksResp = {
  items?: LockRow[];
  error?: string;
};

type NfcCardsResp = {
  ok?: boolean;
  items?: NfcCardRow[];
  error?: string;
};

type NfcStatsResp = {
  ok?: boolean;
  stats?: {
    guest?: number;
    cleaning?: number;
    total?: number;
  };
  error?: string;
};

type NfcSyncResp = {
  ok: boolean;
  error?: string;
  message?: string;
  result?: {
    importedCount?: number;
    updatedCount?: number;
    totalFromTtlock?: number;
    totalAvailable?: number;
    totalGuest?: number;
    totalCleaning?: number;
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

function buttonStyle(
  variant: "primary" | "secondary",
  disabled?: boolean
): React.CSSProperties {
  const primary = variant === "primary";

  return {
    height: 42,
    padding: "0 16px",
    borderRadius: 10,
    border: primary ? "1px solid #111827" : "1px solid #d1d5db",
    background: disabled ? "#e5e7eb" : primary ? "#111827" : "#fff",
    color: disabled ? "#6b7280" : primary ? "#fff" : "#111827",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
  };
}

function statusBoxStyle(
  tone: "success" | "error" | "info" | "warning"
): React.CSSProperties {
  if (tone === "success") {
    return {
      borderRadius: 12,
      padding: 12,
      background: "#f0fdf4",
      border: "1px solid #bbf7d0",
      color: "#166534",
      fontSize: 14,
    };
  }

  if (tone === "error") {
    return {
      borderRadius: 12,
      padding: 12,
      background: "#fef2f2",
      border: "1px solid #fecaca",
      color: "#991b1b",
      fontSize: 14,
    };
  }

  if (tone === "warning") {
    return {
      borderRadius: 12,
      padding: 12,
      background: "#fffbeb",
      border: "1px solid #fde68a",
      color: "#92400e",
      fontSize: 14,
    };
  }

  return {
    borderRadius: 12,
    padding: 12,
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1d4ed8",
    fontSize: 14,
  };
}

function selectStyle(disabled?: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: 42,
    borderRadius: 12,
    border: "1px solid #d1d5db",
    padding: "0 12px",
    background: disabled ? "#f9fafb" : "#fff",
    color: "#111827",
  };
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
    <div style={miniCardStyle()}>
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      {helper ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          {helper}
        </div>
      ) : null}
    </div>
  );
}

function normalizeError(err: unknown, fallback: string) {
  return String((err as any)?.message ?? err ?? fallback);
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";

  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;

  return dt.toLocaleString();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }

  return data;
}

async function loadPropertiesRequest(): Promise<PropertyRow[]> {
  const data = await requestJson<PropertiesResp>("/api/dashboard/properties");
  return data.items ?? [];
}

async function loadLocksRequest(): Promise<LockRow[]> {
  const data = await requestJson<LocksResp>(
    "/api/dashboard/locks?page=1&pageSize=200"
  );
  return data.items ?? [];
}

async function loadCardsRequest(propertyId: string): Promise<NfcCardRow[]> {
  const data = await requestJson<NfcCardsResp>(
    `/access/nfc/cards?propertyId=${encodeURIComponent(propertyId)}`
  );
  return data.items ?? [];
}

async function loadStatsRequest(propertyId: string): Promise<{
  guest: number;
  cleaning: number;
  total: number;
}> {
  const data = await requestJson<NfcStatsResp>(
    `/access/nfc/stats?propertyId=${encodeURIComponent(propertyId)}`
  );

  return {
    guest: Number(data.stats?.guest ?? 0),
    cleaning: Number(data.stats?.cleaning ?? 0),
    total: Number(data.stats?.total ?? 0),
  };
}

export default function NfcSyncPage() {
  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [cards, setCards] = useState<NfcCardRow[]>([]);

  const [propertyId, setPropertyId] = useState("");
  const [lockId, setLockId] = useState("");

  const [loading, setLoading] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cardsError, setCardsError] = useState("");
  const [info] = useState(
    "Selecciona una property y una lock para sincronizar el pool de tarjetas NFC desde TTLock."
  );

  const [lastImportedCount, setLastImportedCount] = useState(0);
  const [lastUpdatedCount, setLastUpdatedCount] = useState(0);
  const [lastTotalFromTtlock, setLastTotalFromTtlock] = useState(0);

  const [availableTotal, setAvailableTotal] = useState(0);
  const [guestTotal, setGuestTotal] = useState(0);
  const [cleaningTotal, setCleaningTotal] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [nextProperties, nextLocks] = await Promise.all([
        loadPropertiesRequest(),
        loadLocksRequest(),
      ]);

      setProperties(nextProperties);
      setLocks(nextLocks);
    } catch (e) {
      setError(
        `No se pudo cargar la data para NFC Sync. ${normalizeError(
          e,
          "Load NFC sync data failed."
        )}`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCards = useCallback(async (nextPropertyId: string) => {
    if (!nextPropertyId) {
      setCards([]);
      setCardsError("");
      return;
    }

    setCardsLoading(true);
    setCardsError("");

    try {
      const nextCards = await loadCardsRequest(nextPropertyId);
      setCards(nextCards);
    } catch (e) {
      setCards([]);
      setCardsError(
        `No se pudo cargar la lista de tarjetas NFC. ${normalizeError(
          e,
          "Load NFC cards failed."
        )}`
      );
    } finally {
      setCardsLoading(false);
    }
  }, []);

  const loadStats = useCallback(async (nextPropertyId: string) => {
    if (!nextPropertyId) {
      setAvailableTotal(0);
      setGuestTotal(0);
      setCleaningTotal(0);
      return;
    }

    setStatsLoading(true);

    try {
      const stats = await loadStatsRequest(nextPropertyId);
      setAvailableTotal(stats.total);
      setGuestTotal(stats.guest);
      setCleaningTotal(stats.cleaning);
    } catch (e) {
      console.error("Failed to load NFC stats", e);
      setAvailableTotal(0);
      setGuestTotal(0);
      setCleaningTotal(0);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!propertyId) {
      setCards([]);
      setCardsError("");
      setAvailableTotal(0);
      setGuestTotal(0);
      setCleaningTotal(0);
      return;
    }

    void loadCards(propertyId);
    void loadStats(propertyId);
  }, [propertyId, loadCards, loadStats]);

  const filteredLocks = useMemo(() => {
    return locks.filter((lock) => lock.property?.id === propertyId);
  }, [locks, propertyId]);

  const selectedProperty = useMemo(() => {
    return properties.find((p) => p.id === propertyId) ?? null;
  }, [properties, propertyId]);

  const selectedLock = useMemo(() => {
    return filteredLocks.find((lock) => lock.id === lockId) ?? null;
  }, [filteredLocks, lockId]);

  async function handleSyncSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!propertyId) {
      setError("Selecciona una property primero.");
      return;
    }

    if (!selectedLock) {
      setError("Selecciona una lock válida primero.");
      return;
    }

    setSyncLoading(true);

    try {
      const resp = await requestJson<NfcSyncResp>("/access/nfc/sync", {
        method: "POST",
        body: JSON.stringify({
          propertyId,
          ttlockLockId: selectedLock.ttlockLockId,
        }),
      });

      if (!resp.ok) {
        throw new Error(resp.error || "NFC sync failed.");
      }

      setLastImportedCount(Number(resp.result?.importedCount ?? 0));
      setLastUpdatedCount(Number(resp.result?.updatedCount ?? 0));
      setLastTotalFromTtlock(Number(resp.result?.totalFromTtlock ?? 0));

      await loadCards(propertyId);
      await loadStats(propertyId);

      setSuccess(
        resp.message ??
          `Sincronización completada. Importadas: ${
            resp.result?.importedCount ?? 0
          }, actualizadas: ${
            resp.result?.updatedCount ?? 0
          }, total desde TTLock: ${resp.result?.totalFromTtlock ?? 0}.`
      );
    } catch (e) {
      setError(
        `No se pudo sincronizar las tarjetas NFC. ${normalizeError(
          e,
          "NFC sync failed."
        )}`
      );
    } finally {
      setSyncLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Link to="/locks">← Back to locks</Link>

      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 8 }}>
          NFC Sync
        </h1>
        <p style={{ color: "#666", margin: 0 }}>
          Sincroniza las tarjetas físicas disponibles desde TTLock hacia el pool
          interno de Pin&amp;Go.
        </p>
      </div>

      {info ? <div style={statusBoxStyle("info")}>{info}</div> : null}
      {error ? <div style={statusBoxStyle("error")}>{error}</div> : null}
      {success ? <div style={statusBoxStyle("success")}>{success}</div> : null}

      <section
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <Stat
          label="Properties"
          value={properties.length}
          helper="Properties disponibles en el dashboard"
        />
        <Stat
          label="Locks"
          value={locks.length}
          helper="Locks disponibles en el dashboard"
        />
        <Stat
          label="Imported"
          value={lastImportedCount}
          helper="Tarjetas nuevas creadas en el último sync"
        />
        <Stat
          label="Updated"
          value={lastUpdatedCount}
          helper="Tarjetas ya existentes actualizadas"
        />
        <Stat
          label="Available NFC"
          value={availableTotal}
          helper={
            statsLoading
              ? "Cargando pool disponible..."
              : "Tarjetas disponibles en el pool"
          }
        />
        <Stat
          label="Guest Cards"
          value={guestTotal}
          helper={
            statsLoading
              ? "Cargando tarjetas guest..."
              : "Tarjetas de huésped disponibles"
          }
        />
        <Stat
          label="Cleaning Cards"
          value={cleaningTotal}
          helper={
            statsLoading
              ? "Cargando tarjetas cleaning..."
              : "Tarjetas de limpieza disponibles"
          }
        />
      </section>

      <section style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>Sync NFC Pool</h3>

        <form
          onSubmit={handleSyncSubmit}
          style={{
            display: "grid",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>Property</span>
              <select
                value={propertyId}
                onChange={(e) => {
                  const nextPropertyId = e.target.value;
                  setPropertyId(nextPropertyId);
                  setLockId("");
                  setError("");
                  setSuccess("");
                  setCardsError("");

                  if (!nextPropertyId) {
                    setCards([]);
                    setAvailableTotal(0);
                    setGuestTotal(0);
                    setCleaningTotal(0);
                  }
                }}
                disabled={loading || syncLoading}
                style={selectStyle(loading || syncLoading)}
              >
                <option value="">
                  {loading ? "Loading properties..." : "Select property"}
                </option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>Lock</span>
              <select
                value={lockId}
                onChange={(e) => {
                  setLockId(e.target.value);
                  setError("");
                  setSuccess("");
                }}
                disabled={loading || syncLoading || !propertyId}
                style={selectStyle(loading || syncLoading || !propertyId)}
              >
                <option value="">
                  {!propertyId
                    ? "Select property first"
                    : filteredLocks.length > 0
                      ? "Select lock"
                      : "No locks available for this property"}
                </option>

                {filteredLocks.map((lock) => (
                  <option key={lock.id} value={lock.id}>
                    {(lock.name ?? "TTLock Lock") + " — " + lock.ttlockLockId}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            <ReadonlyField
              label="Selected Property"
              value={selectedProperty?.name ?? "—"}
            />
            <ReadonlyField
              label="Selected Lock"
              value={
                selectedLock
                  ? `${selectedLock.name ?? "TTLock Lock"} — ${selectedLock.ttlockLockId}`
                  : "—"
              }
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
            <strong>Sync summary:</strong>{" "}
            {selectedProperty?.name ?? "Property not selected"} →{" "}
            {selectedLock
              ? `${selectedLock.name ?? "TTLock Lock"} (${selectedLock.ttlockLockId})`
              : "Lock not selected"}
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
              type="submit"
              disabled={syncLoading || !propertyId || !lockId}
              style={buttonStyle(
                "primary",
                syncLoading || !propertyId || !lockId
              )}
            >
              {syncLoading ? "Syncing..." : "Sync NFC Cards"}
            </button>

            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading || syncLoading}
              style={buttonStyle("secondary", loading || syncLoading)}
            >
              {loading ? "Refreshing..." : "Refresh Dashboard Data"}
            </button>

            <button
              type="button"
              onClick={async () => {
                if (!propertyId) return;
                await loadCards(propertyId);
                await loadStats(propertyId);
              }}
              disabled={!propertyId || cardsLoading || statsLoading || syncLoading}
              style={buttonStyle(
                "secondary",
                !propertyId || cardsLoading || statsLoading || syncLoading
              )}
            >
              {cardsLoading || statsLoading
                ? "Refreshing NFC..."
                : "Refresh NFC Cards"}
            </button>
          </div>
        </form>
      </section>

      <section style={sectionStyle()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>NFC Cards Disponibles </h3>
            <p style={{ margin: "6px 0 0 0", color: "#6b7280", fontSize: 14 }}>
              Lista real de tarjetas NFC guardadas para la property seleccionada.
            </p>
          </div>

          <div style={{ fontSize: 14, color: "#6b7280" }}>
            Total cards: <strong>{cards.length}</strong>
          </div>
        </div>

        {cardsError ? (
          <div style={statusBoxStyle("warning")}>{cardsError}</div>
        ) : null}

        {!propertyId ? (
          <div style={statusBoxStyle("info")}>
            Selecciona una property para cargar las tarjetas NFC guardadas.
          </div>
        ) : cardsLoading ? (
          <div style={statusBoxStyle("info")}>Cargando tarjetas NFC...</div>
        ) : cards.length === 0 ? (
          <div style={statusBoxStyle("warning")}>
            No hay tarjetas NFC guardadas para esta property todavía.
          </div>
        ) : (
          <div
            style={{
              overflowX: "auto",
              border: "1px solid #e5e7eb",
              borderRadius: 14,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 720,
                background: "#fff",
              }}
            >
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                  <th
                    style={{
                      padding: "12px 14px",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    TTLock Card ID
                  </th>
                  <th
                    style={{
                      padding: "12px 14px",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    Label
                  </th>
                  <th
                    style={{
                      padding: "12px 14px",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      padding: "12px 14px",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    Created At
                  </th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.id}>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #f3f4f6",
                        color: "#111827",
                      }}
                    >
                      {card.ttlockCardId}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #f3f4f6",
                        color: "#111827",
                      }}
                    >
                      {card.label ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #f3f4f6",
                        color: "#111827",
                        fontWeight: 600,
                      }}
                    >
                      {card.status}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #f3f4f6",
                        color: "#111827",
                      }}
                    >
                      {formatDateTime(card.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>Operational Notes</h3>

        <div style={{ display: "grid", gap: 12, color: "#6b7280", fontSize: 14 }}>
          <div>
            Las tarjetas sincronizadas quedan en el pool interno de Pin&amp;Go y
            luego pueden ser asignadas a huéspedes, limpieza o staff.
          </div>

          <div>
            Esta pantalla no activa accesos ni asigna tarjetas a reservas. Solo
            sincroniza inventario desde TTLock.
          </div>

          <div>
            Último total recibido desde TTLock:{" "}
            <strong>{lastTotalFromTtlock}</strong>
          </div>
        </div>
      </section>
    </div>
  );
}