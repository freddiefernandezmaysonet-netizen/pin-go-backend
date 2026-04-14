import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

type TuyaUiState = "locked" | "pending_onboarding" | "connected";

type TuyaAccessResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  tuya?: {
    ok?: boolean;
    orgId?: string | null;
    state?: TuyaUiState;
    reason?: string;
    source?: string;
    onboardingRequired?: boolean;
    hasEntitlement?: boolean;
    hasTuyaUid?: boolean;
    priceIds?: string[];
    ui?: {
      state?: TuyaUiState;
      locked?: boolean;
      pendingOnboarding?: boolean;
      connected?: boolean;
      canOpenPremiumCheckout?: boolean;
      canStartOnboarding?: boolean;
      canManageDevices?: boolean;
    };
  };
};

type TuyaBillingConfigResponse = {
  ok: boolean;
  error?: string;
  billing?: {
    feature?: string;
    enabled?: boolean;
    priceIdConfigured?: boolean;
    checkoutMode?: string;
  };
};

type TuyaCheckoutResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  checkout?: {
    sessionId?: string | null;
    url?: string | null;
  };
};

type TuyaDevice = {
  id?: string;
  name?: string | null;
  deviceId?: string | null;
  productName?: string | null;
  category?: string | null;
  online?: boolean | null;
  isOnline?: boolean | null;
  enabled?: boolean | null;
  active?: boolean | null;
  roomName?: string | null;
  propertyName?: string | null;
  lastSeenAt?: string | null;
};

type TuyaDevicesResponse = {
  ok: boolean;
  items?: TuyaDevice[];
  devices?: TuyaDevice[];
  total?: number;
  error?: string;
  message?: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";
const PAGE_TITLE = "Tuya Premium";

function getOrganizationId(): string {
  try {
    return (
      localStorage.getItem("organizationId") ||
      localStorage.getItem("orgId") ||
      ""
    ).trim();
  } catch {
    return "";
  }
}

function buildUrl(path: string, organizationId?: string) {
  const url = new URL(path, API_BASE);

  if (organizationId) {
    url.searchParams.set("organizationId", organizationId);
  }

  return url.toString();
}

function formatDate(value?: string | null) {
  if (!value) return "—";

  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";

  return dt.toLocaleString();
}

function getDeviceOnlineValue(device: TuyaDevice) {
  if (typeof device.isOnline === "boolean") return device.isOnline;
  if (typeof device.online === "boolean") return device.online;
  return null;
}

function getDeviceEnabledValue(device: TuyaDevice) {
  if (typeof device.enabled === "boolean") return device.enabled;
  if (typeof device.active === "boolean") return device.active;
  return null;
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const styles: Record<typeof tone, React.CSSProperties> = {
    neutral: {
      background: "#f3f4f6",
      color: "#374151",
      border: "1px solid #e5e7eb",
    },
    success: {
      background: "#ecfdf5",
      color: "#065f46",
      border: "1px solid #a7f3d0",
    },
    warning: {
      background: "#fffbeb",
      color: "#92400e",
      border: "1px solid #fde68a",
    },
    danger: {
      background: "#fef2f2",
      color: "#991b1b",
      border: "1px solid #fecaca",
    },
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        ...styles[tone],
      }}
    >
      {label}
    </span>
  );
}

function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 20,
        padding: 20,
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "flex-start",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              lineHeight: 1.2,
              color: "#111827",
            }}
          >
            {title}
          </h2>
          {subtitle ? (
            <p
              style={{
                margin: "8px 0 0",
                color: "#6b7280",
                fontSize: 14,
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>

        {right ? <div>{right}</div> : null}
      </div>

      {children}
    </section>
  );
}

export default function TuyaIntegrationPage() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [access, setAccess] = useState<TuyaAccessResponse["tuya"] | null>(null);
  const [billing, setBilling] = useState<TuyaBillingConfigResponse["billing"] | null>(null);
  const [devices, setDevices] = useState<TuyaDevice[]>([]);

  const [error, setError] = useState("");
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const state: TuyaUiState = access?.state ?? "locked";
  const isLocked = state === "locked";
  const isPending = state === "pending_onboarding";
  const isConnected = state === "connected";

  const loadAll = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      setError("");

      try {
        const [accessRes, billingRes] = await Promise.all([
          fetch(buildUrl("/api/org/tuya/access/status", organizationId), {
            credentials: "include",
          }),
          fetch(buildUrl("/api/org/tuya/billing/config", organizationId), {
            credentials: "include",
          }),
        ]);

        const accessJson: TuyaAccessResponse = await accessRes.json().catch(() => ({
          ok: false,
          error: "TUYA_ACCESS_STATUS_PARSE_FAILED",
        }));

        const billingJson: TuyaBillingConfigResponse = await billingRes
          .json()
          .catch(() => ({
            ok: false,
            error: "TUYA_BILLING_CONFIG_PARSE_FAILED",
          }));

        if (!accessRes.ok || !accessJson.ok) {
          throw new Error(
            accessJson.error ||
              accessJson.message ||
              "No se pudo cargar el estado de Tuya"
          );
        }

        setAccess(accessJson.tuya ?? null);
        setBilling(billingJson.billing ?? null);

        if ((accessJson.tuya?.state ?? "locked") === "connected") {
          try {
            const devicesRes = await fetch(
              buildUrl("/api/org/tuya/devices", organizationId),
              {
                credentials: "include",
              }
            );

            const devicesJson: TuyaDevicesResponse = await devicesRes
              .json()
              .catch(() => ({
                ok: false,
                error: "TUYA_DEVICES_PARSE_FAILED",
              }));

            if (devicesRes.ok && devicesJson.ok) {
              const nextDevices = devicesJson.items ?? devicesJson.devices ?? [];
              setDevices(nextDevices);
            } else {
              setDevices([]);
            }
          } catch {
            setDevices([]);
          }
        } else {
          setDevices([]);
        }
      } catch (e: any) {
        setError(e?.message || "No se pudo cargar Tuya");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [organizationId]
  );

  useEffect(() => {
    void loadAll("initial");
  }, [loadAll]);

  const openCheckout = useCallback(async () => {
    setCheckoutLoading(true);
    setError("");

    try {
      const res = await fetch(
        buildUrl("/api/org/tuya/billing/checkout-session", organizationId),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ organizationId }),
        }
      );

      const json: TuyaCheckoutResponse = await res.json().catch(() => ({
        ok: false,
        error: "TUYA_CHECKOUT_PARSE_FAILED",
      }));

      if (!res.ok || !json.ok) {
        throw new Error(
          json.error || json.message || "No se pudo crear la sesión de pago"
        );
      }

      const checkoutUrl = json.checkout?.url?.trim();
      if (!checkoutUrl) {
        throw new Error("Stripe no devolvió una URL válida");
      }

      window.location.href = checkoutUrl;
    } catch (e: any) {
      setError(e?.message || "No se pudo iniciar el checkout de Tuya");
    } finally {
      setCheckoutLoading(false);
    }
  }, [organizationId]);

  const headerBadge = useMemo(() => {
    if (isConnected) {
      return <StatusBadge label="Connected" tone="success" />;
    }

    if (isPending) {
      return <StatusBadge label="Pending onboarding" tone="warning" />;
    }

    return <StatusBadge label="Locked" tone="neutral" />;
  }, [isConnected, isPending]);

  if (loading) {
    return (
      <div
        style={{
          padding: 24,
          display: "grid",
          gap: 20,
        }}
      >
        <SectionCard title={PAGE_TITLE} subtitle="Cargando estado de integración...">
          <div style={{ color: "#6b7280" }}>Cargando...</div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        display: "grid",
        gap: 20,
        background: "#f9fafb",
        minHeight: "100%",
      }}
    >
      <SectionCard
        title={PAGE_TITLE}
        subtitle="Control premium para conexión, onboarding asistido y dispositivos Tuya por organización."
        right={
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {headerBadge}
            <button
              onClick={() => void loadAll("refresh")}
              disabled={refreshing}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 12,
                border: "1px solid #d1d5db",
                background: "#fff",
                color: "#111827",
                fontWeight: 700,
                cursor: refreshing ? "not-allowed" : "pointer",
                opacity: refreshing ? 0.7 : 1,
              }}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        }
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <div
            style={{
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Access state
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
              {state}
            </div>
          </div>

          <div
            style={{
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Entitlement
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
              {access?.hasEntitlement ? "Enabled" : "Not enabled"}
            </div>
          </div>

          <div
            style={{
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Tuya UID
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
              {access?.hasTuyaUid ? "Linked" : "Not linked"}
            </div>
          </div>

          <div
            style={{
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 16,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
              Devices
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
              {devices.length}
            </div>
          </div>
        </div>

        {error ? (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              borderRadius: 14,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        ) : null}
      </SectionCard>

      {isLocked ? (
        <SectionCard
          title="Unlock Tuya Premium"
          subtitle="Tuya está disponible como add-on premium. Activa el entitlement para habilitar onboarding asistido y sincronización de dispositivos."
          right={
            <button
              onClick={() => void openCheckout()}
              disabled={checkoutLoading || !billing?.enabled}
              style={{
                height: 44,
                padding: "0 16px",
                borderRadius: 12,
                border: "1px solid #111827",
                background: "#111827",
                color: "#fff",
                fontWeight: 800,
                cursor:
                  checkoutLoading || !billing?.enabled ? "not-allowed" : "pointer",
                opacity: checkoutLoading || !billing?.enabled ? 0.7 : 1,
              }}
            >
              {checkoutLoading ? "Opening checkout..." : "Unlock Tuya Premium"}
            </button>
          }
        >
          <div
            style={{
              display: "grid",
              gap: 12,
              color: "#374151",
              fontSize: 14,
            }}
          >
            <div>
              Estado actual: sin entitlement premium. La organización no puede usar la integración Tuya todavía.
            </div>

            <div
              style={{
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: 16,
                padding: 16,
              }}
            >
              <div style={{ fontWeight: 800, color: "#111827", marginBottom: 8 }}>
                Qué se habilita con Tuya Premium
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                <li>Onboarding asistido por Pin&amp;Go</li>
                <li>Conexión del UID a la organización</li>
                <li>Sincronización y administración de dispositivos</li>
                <li>Base para automations premium por property</li>
              </ul>
            </div>

            {!billing?.priceIdConfigured ? (
              <div
                style={{
                  padding: 14,
                  borderRadius: 14,
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  fontWeight: 600,
                }}
              >
                El priceId de Tuya no está configurado todavía en el backend.
              </div>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {isPending ? (
        <SectionCard
          title="Pending onboarding"
          subtitle="La organización ya tiene entitlement premium, pero todavía no ha completado el onboarding asistido de Tuya."
          right={
            <a
              href="mailto:support@pingo.com?subject=Tuya%20Onboarding%20Request"
              style={{
                height: 44,
                padding: "0 16px",
                borderRadius: 12,
                border: "1px solid #111827",
                background: "#111827",
                color: "#fff",
                fontWeight: 800,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Schedule onboarding
            </a>
          }
        >
          <div
            style={{
              display: "grid",
              gap: 12,
              color: "#374151",
              fontSize: 14,
            }}
          >
            <div>
              Ya se confirmó el entitlement premium, pero todavía falta completar el enlace del UID y la validación operativa de la cuenta Tuya.
            </div>

            <div
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 16,
                padding: 16,
              }}
            >
              <div style={{ fontWeight: 800, color: "#92400e", marginBottom: 8 }}>
                Próximos pasos
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                <li>Pin&amp;Go agenda onboarding premium</li>
                <li>Se enlaza UID con la organización correcta</li>
                <li>Se valida device sync inicial</li>
                <li>La integración pasa a estado connected</li>
              </ol>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link
                to="/billing"
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  color: "#111827",
                  fontWeight: 700,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                View billing
              </Link>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {isConnected ? (
        <>
          <SectionCard
            title="Connected"
            subtitle="Tuya ya está enlazado con esta organización y la UI puede administrar dispositivos."
            right={
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={() => void loadAll("refresh")}
                  disabled={refreshing}
                  style={{
                    height: 40,
                    padding: "0 14px",
                    borderRadius: 12,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    color: "#111827",
                    fontWeight: 700,
                    cursor: refreshing ? "not-allowed" : "pointer",
                  }}
                >
                  Refresh devices
                </button>
              </div>
            }
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <div
                style={{
                  background: "#ecfdf5",
                  border: "1px solid #a7f3d0",
                  borderRadius: 16,
                  padding: 16,
                }}
              >
                <div style={{ fontSize: 12, color: "#065f46", marginBottom: 6 }}>
                  Integration status
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#065f46" }}>
                  Operational
                </div>
              </div>

              <div
                style={{
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 16,
                  padding: 16,
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                  Total devices
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
                  {devices.length}
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title={`Devices (${devices.length})`}
            subtitle="Inventario actual sincronizado desde Tuya para esta organización."
          >
            {devices.length === 0 ? (
              <div
                style={{
                  padding: 16,
                  borderRadius: 16,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  color: "#6b7280",
                }}
              >
                No hay dispositivos para mostrar todavía.
              </div>
            ) : (
              <div
                style={{
                  overflowX: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 16,
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: 900,
                    background: "#fff",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#f9fafb" }}>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>Device ID</th>
                      <th style={thStyle}>Product</th>
                      <th style={thStyle}>Category</th>
                      <th style={thStyle}>Online</th>
                      <th style={thStyle}>Enabled</th>
                      <th style={thStyle}>Property</th>
                      <th style={thStyle}>Room</th>
                      <th style={thStyle}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((device, index) => {
                      const online = getDeviceOnlineValue(device);
                      const enabled = getDeviceEnabledValue(device);

                      return (
                        <tr key={device.id ?? device.deviceId ?? String(index)}>
                          <td style={tdStyle}>{device.name || "Unnamed device"}</td>
                          <td style={tdStyle}>{device.deviceId || device.id || "—"}</td>
                          <td style={tdStyle}>{device.productName || "—"}</td>
                          <td style={tdStyle}>{device.category || "—"}</td>
                          <td style={tdStyle}>
                            {online === true ? (
                              <StatusBadge label="Online" tone="success" />
                            ) : online === false ? (
                              <StatusBadge label="Offline" tone="danger" />
                            ) : (
                              <StatusBadge label="Unknown" tone="neutral" />
                            )}
                          </td>
                          <td style={tdStyle}>
                            {enabled === true ? (
                              <StatusBadge label="Enabled" tone="success" />
                            ) : enabled === false ? (
                              <StatusBadge label="Disabled" tone="warning" />
                            ) : (
                              <StatusBadge label="Unknown" tone="neutral" />
                            )}
                          </td>
                          <td style={tdStyle}>{device.propertyName || "—"}</td>
                          <td style={tdStyle}>{device.roomName || "—"}</td>
                          <td style={tdStyle}>{formatDate(device.lastSeenAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 12,
  fontWeight: 800,
  color: "#374151",
  padding: "12px 14px",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#111827",
  padding: "12px 14px",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
};