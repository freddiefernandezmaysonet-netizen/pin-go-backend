import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type ConnectResp = {
  ok: boolean;
  error?: string;
  uid?: number | string;
  organizationId?: string;
  connected?: boolean;
};

export default function TtlockConnectPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const organizationId = user?.orgId ?? "";

  const [username, setUsername] = useState("");
  const [passwordPlain, setPasswordPlain] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    setLoading(true);
    setErr(null);
    setMsg(null);

    try {
      const resp = await fetch(`${API_BASE}/api/org/ttlock/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          organizationId,
          username,
          password: passwordPlain,
        }),
      });

      const data: ConnectResp = await resp.json();

      if (!resp.ok || !data.ok) {
        throw new Error(data.error ?? "TTLock connection failed");
      }

      setMsg("TTLock conectado correctamente.");

      setTimeout(() => {
        navigate("/locks");
      }, 800);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: 24,
        display: "grid",
        gap: 20,
      }}
    >
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: "#111827" }}>
          Conectar TTLock
        </h1>

        <p
          style={{
            marginTop: 6,
            fontSize: 14,
            color: "#6b7280",
          }}
        >
          Conecta tu cuenta TTLock para que Pin&Go pueda importar cerraduras y
          automatizar accesos.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 20,
          background: "#fff",
          display: "grid",
          gap: 16,
        }}
      >
        <div
          style={{
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            background: "#f9fafb",
            padding: 12,
            fontSize: 13,
            color: "#4b5563",
          }}
        >
          Organization ID:{" "}
          <span style={{ fontFamily: "monospace" }}>
            {organizationId || "—"}
          </span>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#374151",
            }}
          >
            Usuario / Email TTLock
          </label>

          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="cliente@email.com"
            required
            style={{
              height: 40,
              borderRadius: 10,
              border: "1px solid #d1d5db",
              padding: "0 10px",
            }}
          />
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#374151",
            }}
          >
            Password TTLock
          </label>

          <input
            type="password"
            value={passwordPlain}
            onChange={(e) => setPasswordPlain(e.target.value)}
            placeholder="••••••••"
            required
            style={{
              height: 40,
              borderRadius: 10,
              border: "1px solid #d1d5db",
              padding: "0 10px",
            }}
          />
        </div>

        {msg && (
          <div
            style={{
              borderRadius: 12,
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              padding: 12,
              fontSize: 13,
              color: "#166534",
            }}
          >
            {msg}
          </div>
        )}

        {err && (
          <div
            style={{
              borderRadius: 12,
              border: "1px solid #fecaca",
              background: "#fef2f2",
              padding: 12,
              fontSize: 13,
              color: "#991b1b",
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !organizationId}
          style={{
            height: 42,
            borderRadius: 10,
            border: "1px solid #111827",
            background: loading || !organizationId ? "#9ca3af" : "#111827",
            color: "#ffffff",
            fontWeight: 700,
            cursor: loading || !organizationId ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Conectando..." : "Conectar TTLock"}
        </button>
      </form>
    </div>
  );
}