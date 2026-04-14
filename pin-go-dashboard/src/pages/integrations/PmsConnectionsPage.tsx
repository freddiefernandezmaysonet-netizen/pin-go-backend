import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getOrganizationId } from "../../lib/getOrganizationId";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type ProviderKey = "GUESTY" | "CLOUDBEDS" | "HOSTAWAY" | "LODGIFY";

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
    description: "Connect Guesty securely to sync listings and reservations.",
    enabled: true,
  },
  /*
  {
    key: "CLOUDBEDS",
    label: "Cloudbeds",
    description: "Enabled for dashboard connection and PMS provider expansion.",
    enabled: true,
  },
  */
  {
    key: "HOSTAWAY",
    label: "Hostaway",
    description: "Connect Hostaway securely to sync listings and reservations.",
    enabled: true,
  },  
  {
    key: "LODGIFY",
    label: "Lodgify",
    description: "Connect Lodgify securely using an API key to sync listings and reservations.",
    enabled: true,
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
    resize: "vertical",
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
    case "PMS_ACCOUNT_ID_REQUIRED":
      return "Account ID is required for Hostaway.";
    case "PMS_API_KEY_REQUIRED":
      return "API Key is required for this provider.";
    case "ORGANIZATION_ID_REQUIRED":
      return "Organization ID is required.";
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

function providerCredentialLabels(provider: ProviderKey) {
  if (provider === "CLOUDBEDS") {
    return {
      accountNamePlaceholder: "e.g. My Cloudbeds Portfolio",
      accountIdPlaceholder: "Optional Cloudbeds account identifier",
      clientIdLabel: "Client ID / App Key",
      clientIdPlaceholder: "Cloudbeds Client ID or App Key",
      clientSecretLabel: "Client Secret",
      clientSecretPlaceholder: "Cloudbeds Client Secret",
      apiKeyLabel: "API Key",
      apiKeyPlaceholder: "Optional Cloudbeds API Key",
      infoText:
        "Cloudbeds can stay in onboarding mode until production credentials are available.",
      collectText: "Collect Cloudbeds Access",
      readyText: "Cloudbeds is enabled for PMS provider expansion.",
      afterCredentials: [
        "1. Save the Cloudbeds connection in this page.",
        "2. Load and map PMS listings or room types to Pin&Go properties.",
        "3. Activate reservation ingestion and retry failed webhook events if needed.",
      ],
    };
  }

  if (provider === "HOSTAWAY") {
    return {
      accountNamePlaceholder: "e.g. My Hostaway Portfolio",
      accountIdPlaceholder: "Hostaway Account ID",
      clientIdLabel: "Client ID / API Key",
      clientIdPlaceholder: "Optional Hostaway Client ID",
      clientSecretLabel: "Client Secret",
      clientSecretPlaceholder: "Optional Hostaway Client Secret",
      apiKeyLabel: "API Key",
      apiKeyPlaceholder: "Hostaway API Key",
      infoText:
        "Connect Hostaway securely and complete setup when credentials are available..",
      collectText: "Add Hostaway Credentials",
      readyText: "Hostaway is available for connection setup.",
      afterCredentials: [
        "1. Save the Hostaway connection.",
        "2. Map PMS listings or properties to Pin&Go properties.",
        "3. Enable reservation sync and review any failed events if needed.",
      ],
    };
  }

  if (provider === "LODGIFY") {
    return {
      accountNamePlaceholder: "e.g. My Lodgify Portfolio",
      accountIdPlaceholder: "Not required for Lodgify",
      clientIdLabel: "Client ID",
      clientIdPlaceholder: "Not required for Lodgify",
      clientSecretLabel: "Client Secret",
      clientSecretPlaceholder: "Not required for Lodgify",
      apiKeyLabel: "API Key",
      apiKeyPlaceholder: "Lodgify API Key",
      infoText:
        "Lodgify uses a direct API Key connection.",
      collectText: "Add Lodgify API Key",
      readyText: "Lodgify is available for connection setup. ",
      afterCredentials: [
        "1. Save the Lodgify connection.",
        "2. Map Lodgify listings to Pin&Go properties.",      
        "3. Enable reservation sync and review any failed events if needed.",
      ],
    };
  }

  return {
    accountNamePlaceholder: "e.g. My Guesty Portfolio",
    accountIdPlaceholder: "Optional account identifier",
    clientIdLabel: "Client ID",
    clientIdPlaceholder: "Guesty Client ID",
    clientSecretLabel: "Client Secret",
    clientSecretPlaceholder: "Guesty Client Secret",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "Optional",
    infoText:
      "Add Guesty credentials to connect listings and reservations .",
    collectText: "Add Guesty Access",
    readyText: "Guesty is available for connection setup.",
    afterCredentials: [
      "1. Save the Guesty connection.",
      "2. Map PMS listings to Pin&Go properties.",
      "3. Enable reservation sync and review any failed events if needed.",
    ],
  };
}

export function PmsConnectionsPage() {
  const navigate = useNavigate();

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
    "Add your PMS credentials to configure the connection."
  );

  const selectedProvider = useMemo(
    () => PROVIDERS.find((p) => p.key === provider) ?? PROVIDERS[0],
    [provider]
  );

  const providerLabels = useMemo(
    () => providerCredentialLabels(provider),
    [provider]
  );

  const onboardingReady = Boolean(existingConnection?.hasCredentials);
  const canProceedToMapping =
    provider === "GUESTY" ||
    provider === "CLOUDBEDS" ||
    provider === "HOSTAWAY" ||
    provider === "LODGIFY";

  async function loadConnection(nextProvider: ProviderKey) {
    setLoadingConnection(true);
    setError(null);
    setSuccess(null);

    try {
      const organizationId = getOrganizationId();

      const qs = new URLSearchParams({
        provider: nextProvider,
        organizationId,
      });

      const resp = await fetch(
        `${API_BASE}/api/org/pms/connection?${qs.toString()}`,
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

      setAccountId("");
      setClientId("");
      setClientSecret("");
      setApiKey("");
      setWebhookSecret("");
    } catch (err: any) {
      setExistingConnection(null);
      setError(normalizeError(String(err?.message ?? err ?? "Failed to load PMS connection.")));
    } finally {
      setLoadingConnection(false);
    }
  }

  useEffect(() => {
    void loadConnection(provider);
  }, [provider]);

  useEffect(() => {
    setInfo(providerLabels.infoText);
  }, [providerLabels]);

  async function handleTestConnection(e: React.FormEvent) {
    e.preventDefault();

    if (!selectedProvider.enabled) return;

    setTesting(true);
    setError(null);
    setSuccess(null);
    setInfo(null);

    try {
      const organizationId = getOrganizationId();

      const resp = await fetch(`${API_BASE}/api/org/pms/test-connection`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
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
      setError(normalizeError(String(err?.message ?? err ?? "Connection test failed.")));
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
      const organizationId = getOrganizationId();

      const resp = await fetch(`${API_BASE}/api/org/pms/connect`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
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
      setError(normalizeError(String(err?.message ?? err ?? "Save connection failed.")));
    } finally {
      setSaving(false);
    }
  }

  function openListingsMapping() {
    navigate(`/integrations/pms/listings-mapping?provider=${provider}`);
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
          onClick={openListingsMapping}
          disabled={!canProceedToMapping}
          style={buttonStyle("secondary", !canProceedToMapping)}
        >
          Open Listings Mapping
        </button>
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
                setInfo(providerCredentialLabels(item.key).readyText);
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
              {onboardingReady ? "Listing Mapping" : providerLabels.collectText}
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
        {provider === "GUESTY"
          ? "Add your Guesty credentials to continue with listings mapping ."
          : provider === "CLOUDBEDS"
            ? "Cloudbeds credentials are not required to keep building the dashboard. You can leave this page in onboarding mode and return when production access is available."
            : provider === "HOSTAWAY"
              ? "Add your Hostaway credentials to complete the connection and continue with listings mapping."
              : "Add your Lodgify API Key to continue with listings mapping."}
      </div>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>
          PMS rollout next phase
        </h3>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "1.5fr auto",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>
              Listings Mapping UI is the next operational step
            </div>
            <div style={{ color: "#6b7280", fontSize: 14 }}>
               Continue by mapping PMS listings to your internal properties so reservations can sync correctly.
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={openListingsMapping}
              disabled={!canProceedToMapping}
              style={buttonStyle("primary", !canProceedToMapping)}
            >
              Go to Listings Mapping
            </button>
          </div>
        </div>
      </div>

      <div style={sectionStyle()}>
        <h3 style={{ marginTop: 0, marginBottom: 14 }}>
          What the client needs to provide
        </h3>

        <div style={{ display: "grid", gap: 10, color: "#6b7280", fontSize: 14 }}>
          {provider === "CLOUDBEDS" ? (
            <>
              <div>1. Cloudbeds Client ID / App Key</div>
              <div>2. Cloudbeds Client Secret if applicable</div>
              <div>3. Optional account or portfolio identifier</div>
              <div>4. Optional webhook secret if webhook signing is enabled</div>
            </>
          ) : provider === "HOSTAWAY" ? (
            <>
              <div>1. Hostaway Account ID</div>
              <div>2. Hostaway API Key</div>
              <div>3. Optional Hostaway Client Secret</div>
              <div>4. Optional webhook secret if webhook signing is enabled</div>
            </>
          ) : provider === "LODGIFY" ? (
            <>
              <div>1. Lodgify API Key</div>
              <div>2. Optional account or portfolio name</div>
              <div>3. Optional webhook secret if webhook signing is enabled</div>
              <div>4. Configure Lodgify webhook URL pointing to Pin&Go</div>
            </>
          ) : (
            <>
              <div>1. Guesty Client ID</div>
              <div>2. Guesty Client Secret</div>
              <div>3. Optional account identifier or portfolio name</div>
              <div>4. Optional webhook secret if webhook signing is enabled</div>
            </>
          )}
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
              placeholder={providerLabels.accountNamePlaceholder}
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Account ID</span>
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder={providerLabels.accountIdPlaceholder}
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>
              {providerLabels.clientIdLabel}
            </span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={providerLabels.clientIdPlaceholder}
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>
              {providerLabels.clientSecretLabel}
            </span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={providerLabels.clientSecretPlaceholder}
              disabled={!selectedProvider.enabled || saving || testing}
              style={inputStyle(!selectedProvider.enabled || saving || testing)}
            />
          </label>

          <label style={labelStyle()}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>
              {providerLabels.apiKeyLabel}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={providerLabels.apiKeyPlaceholder}
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
          {providerLabels.afterCredentials.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}