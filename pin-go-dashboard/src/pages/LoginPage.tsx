import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { login } from "../api/auth";
import { fetchProperties } from "../api/properties";
import { useAuth } from "../auth/AuthProvider";

export default function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      await login(email, password);
      await refresh();

      const propsData = await fetchProperties();

      if (!propsData.items?.length) {
        navigate("/onboarding/property");
        return;
      }

      navigate("/overview");
    } catch {
      setError("Invalid email or password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, rgba(37, 99, 235, 0.08), transparent 30%), linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1000,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          background: "white",
          borderRadius: 20,
          boxShadow: "0 20px 60px rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
      >
        {/* LEFT PANEL */}
        <div
          style={{
            background: "#0f172a",
            color: "white",
            padding: 40,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/pin-go-logo.png" style={{ width: 48 }} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 22 }}>Pin&Go</div>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>
                Control total para propiedades inteligentes
              </div>
            </div>
          </div>

          <h1 style={{ marginTop: 30, fontSize: 36 }}>
            Welcome back
          </h1>

          <p style={{ color: "#94a3b8", marginTop: 10 }}>
            Manage access, automate operations, and deliver a seamless guest experience.
          </p>

          <ul style={{ marginTop: 20, lineHeight: 1.8 }}>
            <li>✔ Access control & NFC</li>
            <li>✔ PMS integrations</li>
            <li>✔ Smart automation</li>
          </ul>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ padding: 40 }}>
          <h2>Sign in</h2>

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
            <input
              type="email"
              placeholder="admin@pingo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />

            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />

            <div style={{ textAlign: "right" }}>
              <Link to="/forgot-password">Forgot password?</Link>
            </div>

            {error && <div style={{ color: "red" }}>{error}</div>}

            <button type="submit" disabled={submitting} style={btn}>
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <div style={{ marginTop: 20 }}>
            Don't have an account?{" "}
            <Link to="/signup">Create one</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 46,
  borderRadius: 12,
  border: "1px solid #d1d5db",
  padding: "0 14px",
};

const btn: React.CSSProperties = {
  height: 46,
  borderRadius: 12,
  border: "none",
  background: "#2563eb",
  color: "white",
  fontWeight: 700,
};