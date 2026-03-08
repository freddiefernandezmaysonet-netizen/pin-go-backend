import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type ProviderKey = "GUESTY" | "CLOUDBEDS" | "HOSTAWAY";

type ConnectionResp = {
  ok: boolean;
  error?: string;
  connection?: {
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
  } | null;
};

type ActionResp = {
  ok: boolean;
  error?: string;
  message?: string;
  connection?: {
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
};

type ProviderOption = {
  key: ProviderKey;
  label: string;
  description: string;
  enabled: boolean;
};

const PROVIDERS: ProviderOption[] = [
  {
    key: "GUESTY",
    label: "Guesty",
    description: "Primary PMS connection for the current Pin&Go rollout.",
    enabled: true,
  },
  {
    key: "CLOUDBEDS",
    label: "Cloudbeds",
    description: "Reserved for the next PMS connection phase.",
    enabled: false,
  },
  {
    key: "HOSTAWAY",
    label: "Hostaway",
    description: "Planned for future provider expansion.",
    enabled: false,
  },
];

function cardStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: active ? "1.5px solid #111827" : "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 18,
    background: disabled ? "#f9fafb" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
    textAlign: "left",
  };
}

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

function labelStyle(): React.CSSProperties {
  return {
    display: "grid",
    gap: 6,
  };
}

function inputStyle(disabled?: boolean): React.CSSProperties {
  return {
    height: 42,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    padding: "0 12px",
    background: disabled ? "#f9fafb" : "#fff",
    color: "#111827",
  };
}

function textAreaStyle(disabled?: boolean): React.CSSProperties {
  return {
    borderRadius: 12,
    border: "1px solid #d1d5db",
    padding: 12,
    background: disabled ? "#f9fafb" : "#fff",
    color: "#111827",
    resize: "vertical" as const,
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

function normalizeError(error?: string) {
  switch (error) {
    case "INVALID_PROVIDER":
      return "Select a valid PMS provider.";
    case "INVALID_PAYLOAD":
      return "Review the form fields and try again.";
    case "PMS_CLIENT_ID_REQUIRED":
      return "Client ID is required for Guesty.";
    case "PMS_CLIENT_SECRET_REQUIRED":
      return "Client Secret is required for Guesty.";
    default:
      return error ?? "Unexpected PMS connection error.";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function PmsConnectionsPage() {
  const [provider, setProvider] = useState<ProviderKey>("GUESTY");

  const [accountName, setAccountName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [notes, setNotes] = useState("");

  const [existingConnection, setExistingConnection] =
    useState<ConnectionResp["connection"]>(null);

  const [loadingConnection, setLoadingConnection] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    "This page can stay in onboarding mode until the client shares Guesty credentials."
  );

  const selectedProvider = useMemo(
    () => PROVIDERS.find((p) => p.key === provider) ?? PROVIDERS[0],
    [provider]
  );

  const onboardingReady = Boolean(existingConnection?.hasCredentials);

  async function loadConnection(nextProvider: ProviderKey) {
    setLoadingConnection(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(
        `${API_BASE}/api/org/pms/connection?provider=${encodeURIComponent(nextProvider)}`,
        {
          credentials: "include",
        }
      );

      const data: ConnectionResp = await resp.json();

      if (!resp.ok || !data.ok) {
        setExistingConnection(null);
        setError(normalizeError(data.error));
        return;
      }

      setExistingConnection(data.connection ?? null);

      if (data.connection?.metadata) {
        setAccountName(data.connection.metadata.accountName ?? "");
        setNotes(data.connection.metadata.notes ?? "");
      } else {
        setAccountName("");
        setNotes("");
      }

      setClientSecret("");
      setApiKey("");
      setWebhookSecret("");
    } catch (err: any) {
      setExistingConnection(null);
      setError(String(err?.message ?? err ?? "Failed to load PMS connection."));
    } finally {
      setLoadingConnection(false);
    }
  }

  useEffect(() => {
    void loadConnection(provider);
  }, [provider]);

  async function handleTestConnection(e: React.FormEvent) {
    e.preventDefault();

    if (!selectedProvider.enabled) return;

    setTesting(true);
    setError(null);
    setSuccess(null);
    setInfo(null);

    try {
      const resp = await fetch(`${API_BASE}/api/org/pms/test-connection`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider,
          accountName: accountName.trim() || undefined,
          accountId: accountId.trim() || undefined,
          clientId: clientId.trim() || undefined,
          clientSecret: clientSecret.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          webhookSecret: webhookSecret.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });

      const data: ActionResp = await resp.json();

      if (!resp.ok || !data.ok) {
        setError(normalizeError(data.error));
        return;
      }

      setSuccess(data.message ?? "Connection payload validated successfully.");
    } catch (err: any) {
      setError(String(err?.message ?? err ?? "Connection test failed."));
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveConnection(e: React.FormEvent) {
    e.preventDefault();

    if (!selectedProvider.enabled) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    setInfo(null);

    try {
      const resp = await fetch(`${API_BASE}/api/org/pms/connect`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider,
          accountName: accountName.trim() || undefined,
          accountId: accountId.trim() || undefined,
          clientId: clientId.trim() || undefined,
          clientSecret: clientSecret.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          webhookSecret: webhookSecret.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });

      const data: ActionResp = await resp.json();

      if (!resp.ok || !data.ok) {
        setError(normalizeError(data.error));
        return;
      }

      setSuccess(data.message ?? "PMS connection saved successfully.");
      await loadConnection(provider);
    } catch (err: any) {
      setError(String(err?.message ?? err ?? "Save connection failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 8 }}>
          PMS Connections
        </h1>
        <p style={{ color: "#6b7280", margin: 0 }}>
          Prepare Pin&Go to connect with your PMS provider and continue later
          when production credentials are available.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {PROVIDERS.map((item) => {
          const active = item.key === provider;

          return (
            <button
              key={item.key}
              type="button"
              disabled={!item.enabled}
              onClick={() => {
                if (!item.enabled) return;
                setProvider(item.key);
                setError(null);
                setSuccess(null);
                setInfo(
                  item.key === "GUESTY"
                    ? "Guesty is enabled first for the PMS rollout."
                    : null
                );
              }}
              style={cardStyle(active, !item.enabled)}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontSize: 18, fontWeight: 700 }}>{item.label}</div>
                <div
                  style={{
                    fontSize: 12,
                    borderRadius: 999,
                    padding: "4px 10px",
                    background: item.enabled ? "#ecfdf5" : "#f3f4f6",
                    color: item.enabled ? "#166534" : "#6b7280",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  {item.enabled ? "Enabled" : "Later"}
                </div>
              </div>

              <div style={{ fontSize: 14, color: "#6b7280" }}>
                {item.description}
              </div>
            </button>
          );
        })}
      </div>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>Onboarding Status</h3>

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
              {selectedProvider.label}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Current Phase
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {onboardingReady ? "Configured" : "Awaiting Credentials"}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Next Step
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {onboardingReady ? "Listing Mapping" : "Collect Guesty Access"}
            </div>
          </div>

          <div style={miniCardStyle()}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Existing Connection
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {existingConnection ? existingConnection.status : "Not Saved"}
            </div>
          </div>
        </div>
      </div>

      <div style={statusBoxStyle("warning")}>
        Guesty credentials are not required to keep building the dashboard.
        You can leave this page in onboarding mode and return when the client
        shares real access details.
      </div>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>
          What the client needs to provide
        </h3>

        <div style={{ display: "grid", gap: 10, color: "#6b7280", fontSize: 14 }}>
          <div>1. Guesty Client ID</div>
          <div>2. Guesty Client Secret</div>
          <div>3. Optional account identifier or portfolio name</div>
          <div>4. Optional webhook secret if webhook signing is enabled</div>
        </div>
      </div>

      <form onSubmit={handleSaveConnection} style={sectionStyle()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>{selectedProvider.label} Connection</h3>
            <p style={{ margin: "6px 0 0 0", color: "#6b7280", fontSize: 14 }}>
              Save credentials by organization when they become available.
            </p>
          </div>

          <div
            style={{
              fontSize: 12,
              borderRadius: 999,
              padding: "6px 10px",
              background: selectedProvider.enabled ? "#ecfdf5" : "#f3f4f6",
              color: selectedProvider.enabled ? "#166534" : "#6b7280",
              border: "1px solid #e5e7eb",
            }}
          >
            {selectedProvider.enabled ? "Ready to configure" : "Not enabled yet"}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            marginBottom: 14,
          }}
        >
          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Provider</span>
            <input value={selectedProvider.label} readOnly disabled style={inputStyle(true)} />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Account Name</span>
            <input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="e.g. My Guesty Portfolio"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Account ID</span>
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="Optional account identifier"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Client ID</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Guesty Client ID"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Client Secret</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Guesty Client Secret"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Optional"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Webhook Secret</span>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="Optional"
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>
        </div>

        <label style={{ ...labelStyle(), marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: "#6b7280" }}>Internal Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional onboarding or support notes"
            disabled={!selectedProvider.enabled || saving || testing}
            rows={4}
            style={textAreaStyle(!selectedProvider.enabled || saving || testing)}
          />
        </label>

        {info ? <div style={statusBoxStyle("info")}>{info}</div> : null}
        {error ? <div style={statusBoxStyle("error")}>{error}</div> : null}
        {success ? <div style={statusBoxStyle("success")}>{success}</div> : null}

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={!selectedProvider.enabled || saving || testing}
            style={buttonStyle("secondary", !selectedProvider.enabled || saving || testing)}
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>

          <button
            type="submit"
            disabled={!selectedProvider.enabled || saving || testing}
            style={buttonStyle("primary", !selectedProvider.enabled || saving || testing)}
          >
            {saving ? "Saving..." : "Save Connection"}
          </button>
        </div>
      </form>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>Current Connection Status</h3>

        {loadingConnection ? (
          <div style={{ color: "#6b7280" }}>Loading connection...</div>
        ) : !existingConnection ? (
          <div style={{ color: "#6b7280" }}>
            No saved connection yet for {selectedProvider.label}.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            <div style={miniCardStyle()}>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
                Status
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {existingConnection.status}
              </div>
            </div>

            <div style={miniCardStyle()}>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
                Credentials
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {existingConnection.hasCredentials ? "Saved" : "Missing"}
              </div>
            </div>

            <div style={miniCardStyle()}>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
                Webhook Secret
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {existingConnection.hasWebhookSecret ? "Saved" : "Missing"}
              </div>
            </div>

            <div style={miniCardStyle()}>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
                Last Configured
              </div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {formatDate(
                  existingConnection.metadata?.lastConfiguredAt ??
                    existingConnection.updatedAt
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0 }}>What comes after credentials are available</h3>
        <div style={{ color: "#6b7280", fontSize: 14, display: "grid", gap: 8 }}>
          <div>1. Save the Guesty connection in this page.</div>
          <div>2. Load and map PMS listings to Pin&Go properties.</div>
          <div>3. Activate reservation ingestion and retry failed webhook events if needed.</div>
        </div>
      </div>
    </div>
  );
}