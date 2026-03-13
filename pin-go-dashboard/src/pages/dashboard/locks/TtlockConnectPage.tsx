import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type ConnectResp = {
  ok: boolean;
  error?: string;
  uid?: number | string;
  lockCount?: number;
};

export function TtlockConnectPage() {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [passwordPlain, setPasswordPlain] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    setErr(null);

    try {
      const resp = await fetch(`${API_BASE}/api/org/ttlock/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username,
          passwordPlain,
        }),
      });

      const data: ConnectResp = await resp.json();

      if (!resp.ok || !data.ok) {
        throw new Error(data.error ?? "No se pudo conectar TTLock");
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
    <div className="mx-auto max-w-lg p-6">
      <h1 className="text-2xl font-semibold mb-2">Conectar TTLock</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Conecta la cuenta TTLock del cliente para importar cerraduras y automatizar accesos con Pin&amp;Go.
      </p>

      <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border p-5 shadow-sm">
        <div>
          <label className="mb-1 block text-sm font-medium">Usuario / Email TTLock</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            placeholder="cliente@email.com"
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Password TTLock</label>
          <input
            type="password"
            value={passwordPlain}
            onChange={(e) => setPasswordPlain(e.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            placeholder="••••••••"
            required
          />
        </div>

        {msg && (
          <div className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">
            {msg}
          </div>
        )}

        {err && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? "Conectando..." : "Conectar TTLock"}
        </button>
      </form>
    </div>
  );
}