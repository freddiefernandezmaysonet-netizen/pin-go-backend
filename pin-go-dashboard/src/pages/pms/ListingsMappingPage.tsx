import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getOrganizationId } from "../../lib/getOrganizationId";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type ProviderKey = "GUESTY" | "CLOUDBEDS" | "HOSTAWAY" | "LODGIFY";

type PmsConnection = {
  id: string;
  organizationId: string;
  provider: ProviderKey;
  status: string;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
  metadata: {
    accountName?: string | null;
    notes?: string | null;
    connectedFrom?: string | null;
    lastConfiguredAt?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type ConnectionResp = {
  ok: boolean;
  error?: string;
  connection?: PmsConnection | null;
};

type PendingPmsListing = {
  id: string;
  externalListingId: string;
  name: string;
  createdAt?: string;
  suggestedPropertyId?: string | null;
  suggestedPropertyName?: string | null;
};

type PendingListingsResp = {
  ok: boolean;
  error?: string;
  provider?: string;
  items?: PendingPmsListing[];
};

type DashboardPropertyItem = {
  id: string;
  name: string;
  locks: number;
  activeReservations: number;
  pms: string;
  status: string;
};

type DashboardPropertiesResp = {
  items?: DashboardPropertyItem[];
};

type PropertyItem = {
  id: string;
  name: string;
};

type MapListingResp = {
  ok: boolean;
  error?: string;
  listing?: {
    id: string;
    propertyId?: string | null;
  };
};

type RetryFailedResp = {
  ok: boolean;
  error?: string;
  retried?: number;
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

function statusColor(status?: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "CONNECTED" || s === "ACTIVE") return "#065f46";
  if (s === "PENDING") return "#92400e";
  if (s === "ERROR" || s === "DISCONNECTED") return "#991b1b";
  return "#374151";
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function normalizeError(err: unknown, fallback: string) {
  return String((err as any)?.message ?? err ?? fallback);
}

function resolveProviderLabel(provider: ProviderKey) {
  switch (provider) {
    case "CLOUDBEDS":
      return "Cloudbeds";
    case "HOSTAWAY":
      return "Hostaway";
    case "LODGIFY":
      return "Lodgify";
    default:
      return "Guesty";
  }
}

function resolveProviderInfo(provider: ProviderKey) {
  if (provider === "CLOUDBEDS") {
    return {
      emptyConnection:
        "No saved Cloudbeds connection was found. Return to PMS Connections and save it first.",
      emptyListings:
        "There are no pending Cloudbeds listings. This usually means they are already mapped or no new listings have arrived.",
      mappingHint:
        "Map each pending Cloudbeds listing to an internal property. Then you can retry failed webhooks.",
    };
  }

  if (provider === "HOSTAWAY") {
    return {
      emptyConnection:
        "No saved Hostaway connection was found. Return to PMS Connections and save it first.",
      emptyListings:
        "There are no pending Hostaway listings.",
      mappingHint:
        "Map each pending PMS listing to an internal property. Then you can retry failed webhooks.",
    };
  }

  if (provider === "LODGIFY") {
    return {
      emptyConnection:
        "No saved Lodgify connection was found. Return to PMS Connections and save it first.",
      emptyListings:
        "There are no pending Lodgify listings. This usually means they are already mapped or no new listings have arrived.",
      mappingHint:
        "Map each pending Lodgify listing to an internal property. Then you can retry failed webhooks.",
    };
  }

  return {
    emptyConnection:
      "No saved Guesty connection was found. Return to PMS Connections and save it first.",
    emptyListings:
      "There are no pending Guesty listings. This usually means they are already mapped or no new listings have arrived.",
    mappingHint:
      "Map each pending Guesty listing to an internal property. Then you can retry failed webhooks.",
  };
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

async function loadConnection(provider: ProviderKey): Promise<PmsConnection | null> {
  const qs = new URLSearchParams({
    provider,
  });

  const organizationId = getOrganizationId();
  if (organizationId) {
    qs.set("organizationId", organizationId);
  }

  const data = await requestJson<ConnectionResp>(
    `/api/org/pms/connection?${qs.toString()}`
  );

  if (!data.ok) {
    throw new Error(data.error || "Failed to load PMS connection.");
  }

  return data.connection ?? null;
}

async function loadPropertiesRequest(): Promise<PropertyItem[]> {
  const data = await requestJson<DashboardPropertiesResp>("/api/dashboard/properties");

  return (data.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
}

export default function ListingsMappingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const rawProvider = (searchParams.get("provider") ?? "GUESTY").toUpperCase();
  const selectedProvider: ProviderKey =
    rawProvider === "CLOUDBEDS" ||
    rawProvider === "HOSTAWAY" ||
    rawProvider === "LODGIFY"
      ? (rawProvider as ProviderKey)
      : "GUESTY";

  const providerLabel = useMemo(
    () => resolveProviderLabel(selectedProvider),
    [selectedProvider]
  );

  const providerInfo = useMemo(
    () => resolveProviderInfo(selectedProvider),
    [selectedProvider]
  );

  const [connection, setConnection] = useState<PmsConnection | null>(null);
  const [pendingListings, setPendingListings] = useState<PendingPmsListing[]>([]);
  const [properties, setProperties] = useState<PropertyItem[]>([]);
  const [draftMappings, setDraftMappings] = useState<Record<string, string>>({});
  const [savingByListingId, setSavingByListingId] = useState<Record<string, boolean>>({});

  const [loadingConnection, setLoadingConnection] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [info, setInfo] = useState(
     `Map pending ${providerLabel} listings to internal Pin&Go properties.`
  );

  const readyToMapCount = useMemo(() => {
    return Object.values(draftMappings).filter(Boolean).length;
  }, [draftMappings]);

  useEffect(() => {
    setInfo(`Map pending ${providerLabel} listings to internal Pin&Go properties.`);
  }, [providerLabel]);

  useEffect(() => {
    let active = true;

    async function run() {
      setLoadingConnection(true);
      setError("");
      setSuccess("");

      try {
        const nextConnection = await loadConnection(selectedProvider);

        if (!active) return;

        setConnection(nextConnection);

        if (!nextConnection) {
          setInfo(providerInfo.emptyConnection);
        }
      } catch (e) {
        if (!active) return;
        setConnection(null);
        setError(
          `Could not load the PMS connection. ${normalizeError(
            e,
            "Load connection failed."
          )}`
        );
      } finally {
        if (active) setLoadingConnection(false);
      }
    }

    void run();

    return () => {
      active = false;
    };
  }, [selectedProvider, providerInfo.emptyConnection]);

  useEffect(() => {
    if (!connection?.id) {
      setPendingListings([]);
      setProperties([]);
      setDraftMappings({});
      return;
    }

    let active = true;

    async function loadData() {
      setLoadingData(true);
      setError("");
      setSuccess("");

      try {
        const [pendingResp, nextProperties] = await Promise.all([
          requestJson<PendingListingsResp>(
            `/api/pms/listings/pending?connectionId=${encodeURIComponent(connection.id)}`
          ),
          loadPropertiesRequest(),
        ]);

        if (!active) return;

        if (!pendingResp.ok) {
          throw new Error(pendingResp.error || "Failed to load pending listings.");
        }

        const nextListings = pendingResp.items ?? [];

        setPendingListings(nextListings);
        setProperties(nextProperties);

        const drafts: Record<string, string> = {};
        for (const item of nextListings) {
          drafts[item.id] = item.suggestedPropertyId ?? "";
        }
        setDraftMappings(drafts);

        if (nextListings.length === 0) {
          setInfo(providerInfo.emptyListings);
        } else {
          const suggestedCount = nextListings.filter((x) => x.suggestedPropertyId).length;

          if (suggestedCount > 0) {
            setInfo(
              `${providerInfo.mappingHint} Pin&Go encontró ${suggestedCount} sugerencia(s) automática(s) por nombre.`
            );
          } else {
            setInfo(providerInfo.mappingHint);
          }
        }
      } catch (e) {
        if (!active) return;
        setPendingListings([]);
        setProperties([]);
        setDraftMappings({});
        setError(
          `Could not load mapping data. ${normalizeError(
            e,
            "Load mapping data failed."
          )}`
        );
      } finally {
        if (active) setLoadingData(false);
      }
    }

    void loadData();

    return () => {
      active = false;
    };
  }, [connection?.id, providerInfo.emptyListings, providerInfo.mappingHint]);

  function updateDraft(listingId: string, propertyId: string) {
    setDraftMappings((prev) => ({
      ...prev,
      [listingId]: propertyId,
    }));
  }

  async function handleMapListing(listingId: string) {
    const propertyId = draftMappings[listingId];

    if (!propertyId) {
      setError("mapping.");
      setSuccess("Select a property before saving the mapping");
      return;
    }

    setSavingByListingId((prev) => ({ ...prev, [listingId]: true }));
    setError("");
    setSuccess("");

    try {
      const resp = await requestJson<MapListingResp>(
        `/api/pms/listings/${encodeURIComponent(listingId)}/map`,
        {
          method: "POST",
          body: JSON.stringify({ propertyId }),
        }
      );

      if (!resp.ok) {
        throw new Error(resp.error || "Map listing failed.");
      }

      setPendingListings((prev) => prev.filter((item) => item.id !== listingId));
      setDraftMappings((prev) => {
        const next = { ...prev };
        delete next[listingId];
        return next;
      });

      setSuccess("Listing mapped successfully.");
      setInfo(
        `You can continue mapping the remaining ${providerLabel} listings. When finished, you can retry failed webhooks .`
      );
    } catch (e) {
      setError(
        `Could not map the listing. ${normalizeError(
          e,
          "Map listing failed."
        )}`
      );
    } finally {
      setSavingByListingId((prev) => ({ ...prev, [listingId]: false }));
    }
  }

  async function handleRetryFailed() {
    if (!connection?.id) return;

    setRetryingFailed(true);
    setError("");
    setSuccess("");

    try {
      const resp = await requestJson<RetryFailedResp>(
        `/api/pms/listings/retry-failed/${encodeURIComponent(connection.id)}`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );

      if (!resp.ok) {
        throw new Error(resp.error || "Retry failed webhooks failed.");
      }

      setSuccess(`Failed events moved back to PENDING: ${resp.retried ?? 0}.`);
    } catch (e) {
      setError(
        `Could not retry failed webhooks. ${normalizeError(
          e,
          "Retry failed webhooks failed."
        )}`
      );
    } finally {
      setRetryingFailed(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => navigate("/integrations/pms")}
          style={buttonStyle("secondary")}
        >
          Back to PMS Connections
        </button>

        <button
          type="button"
          onClick={handleRetryFailed}
          disabled={!connection?.id || retryingFailed}
          style={buttonStyle("primary", !connection?.id || retryingFailed)}
        >
          {retryingFailed ? "Retrying..." : "Retry Failed Webhooks"}
        </button>
      </div>

      {info ? <div style={statusBoxStyle("info")}>{info}</div> : null}
      {error ? <div style={statusBoxStyle("error")}>{error}</div> : null}
      {success ? <div style={statusBoxStyle("success")}>{success}</div> : null}

      <section style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>Connection Summary</h3>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Provider
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {loadingConnection ? "Loading..." : providerLabel}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Status
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: statusColor(connection?.status),
              }}
            >
              {connection?.status ?? "Not configured"}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Account
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {connection?.metadata?.accountName ?? "—"}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Pending Listings
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {pendingListings.length}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Ready to Map
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {readyToMapCount}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Last Configured
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {formatDate(
                connection?.metadata?.lastConfiguredAt ?? connection?.updatedAt
              )}
            </div>
          </div>
        </div>
      </section>

      <section style={sectionStyle()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>Pending Listings</h3>
            <p style={{ margin: "6px 0 0 0", color: "#6b7280", fontSize: 14 }}>
              Each row is saved individually using the live backend endpoint.
            </p>
          </div>
        </div>

        {loadingData ? (
          <div style={{ color: "#6b7280" }}>Loading pending listings and properties...</div>
        ) : !connection?.id ? (
          <div style={statusBoxStyle("warning")}>
            {providerInfo.emptyConnection}
          </div>
        ) : pendingListings.length === 0 ? (
          <div style={statusBoxStyle("warning")}>
            There are no pending listings for this connection..
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    Listing Name
                  </th>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    External ID
                  </th>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    Suggested Property
                  </th>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    Created
                  </th>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    Property
                  </th>
                  <th style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {pendingListings.map((listing) => {
                  const propertyId = draftMappings[listing.id] ?? "";
                  const saving = Boolean(savingByListingId[listing.id]);

                  return (
                    <tr key={listing.id}>
                      <td style={{ padding: 14, borderBottom: "1px solid #f3f4f6" }}>
                        <div style={{ fontWeight: 600 }}>{listing.name}</div>
                      </td>

                      <td
                        style={{
                          padding: 14,
                          borderBottom: "1px solid #f3f4f6",
                          color: "#6b7280",
                          fontFamily: "monospace",
                          fontSize: 13,
                        }}
                      >
                        {listing.externalListingId}
                      </td>

                      <td
                        style={{
                          padding: 14,
                          borderBottom: "1px solid #f3f4f6",
                          fontSize: 14,
                        }}
                      >
                        {listing.suggestedPropertyName ? (
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "6px 10px",
                              borderRadius: 999,
                              background: "#ecfdf5",
                              border: "1px solid #bbf7d0",
                              color: "#166534",
                              fontWeight: 600,
                            }}
                          >
                            {listing.suggestedPropertyName}
                          </div>
                        ) : (
                          <span style={{ color: "#6b7280" }}>—</span>
                        )}
                      </td>

                      <td
                        style={{
                          padding: 14,
                          borderBottom: "1px solid #f3f4f6",
                          color: "#6b7280",
                          fontSize: 14,
                        }}
                      >
                        {formatDate(listing.createdAt)}
                      </td>

                      <td style={{ padding: 14, borderBottom: "1px solid #f3f4f6" }}>
                        <select
                          value={propertyId}
                          onChange={(e) => updateDraft(listing.id, e.target.value)}
                          disabled={saving}
                          style={{
                            ...selectStyle(saving),
                            minWidth: 240,
                            height: 40,
                            borderRadius: 10,
                          }}
                        >
                          <option value="">Select property</option>
                          {properties.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td style={{ padding: 14, borderBottom: "1px solid #f3f4f6" }}>
                        <button
                          type="button"
                          onClick={() => handleMapListing(listing.id)}
                          disabled={!propertyId || saving}
                          style={buttonStyle("primary", !propertyId || saving)}
                        >
                          {saving ? "Saving..." : "Map Listing"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        <div style={sectionStyle()}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Ready</div>
          <div style={{ color: "#6b7280", marginTop: 6, fontSize: 14 }}>
            Listings that already have a property selected in the UI.
          </div>

          <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
            {pendingListings.filter((l) => Boolean(draftMappings[l.id])).length === 0 ? (
              <div style={{ color: "#6b7280" }}>There are no rows ready to save yet.</div>
            ) : (
              pendingListings
                .filter((l) => Boolean(draftMappings[l.id]))
                .map((l) => {
                  const property = properties.find((p) => p.id === draftMappings[l.id]);

                  return (
                    <div
                      key={l.id}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        padding: 12,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{l.name}</div>
                      <div style={{ color: "#6b7280", marginTop: 4, fontSize: 14 }}>
                        → {property?.name ?? "Selected property"}
                      </div>
                    </div>
                  );
                })
            )}
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Still Pending</div>
          <div style={{ color: "#6b7280", marginTop: 6, fontSize: 14 }}>
            Pending listings that do not yet have a selected property.
          </div>

          <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
            {pendingListings.filter((l) => !draftMappings[l.id]).length === 0 ? (
              <div style={{ color: "#065f46" }}>All pending listings already have a selected property.</div>
            ) : (
              pendingListings
                .filter((l) => !draftMappings[l.id])
                .map((l) => (
                  <div
                    key={l.id}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      padding: 12,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{l.name}</div>
                    <div style={{ color: "#6b7280", marginTop: 4, fontSize: 14 }}>
                      External ID: {l.externalListingId}
                    </div>
                    {l.suggestedPropertyName ? (
                      <div style={{ color: "#166534", marginTop: 4, fontSize: 14 }}>
                        Suggested: {l.suggestedPropertyName}
                      </div>
                    ) : null}
                  </div>
                ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}