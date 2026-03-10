import { useState } from "react";
import { login } from "../api/auth";
import { useAuth } from "../auth/AuthProvider";
import { useNavigate } from "react-router-dom";

export default function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    try {
      await login(email, password);
      await refresh();
      navigate("/overview");
    } catch {
      setError("Invalid credentials");
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "100px auto" }}>
      <h2>Pin&Go Dashboard</h2>

      <form onSubmit={handleSubmit}>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", marginBottom: 10 }}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", marginBottom: 10 }}
        />

        {error && <div style={{ color: "red" }}>{error}</div>}

        <button style={{ width: "100%" }}>
          Login
        </button>
      </form>
    </div>
  );
}