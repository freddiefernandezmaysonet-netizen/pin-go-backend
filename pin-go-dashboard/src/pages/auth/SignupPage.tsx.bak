import { useState } from "react";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

type SignupCheckoutResponse = {
  ok: boolean;
  url?: string;
  pendingSignupId?: string;
  error?: string;
  details?: string[];
};

export default function SignupPage() {
  const [organizationName, setOrganizationName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [locks, setLocks] = useState(1);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function validatePassword(passwordValue: string, emailValue: string) {
    const trimmed = String(passwordValue ?? "").trim();
    const errors: string[] = [];

    if (trimmed.length < 12) {
      errors.push("At least 12 characters.");
    }

    if (!/[A-Z]/.test(trimmed)) {
      errors.push("1 uppercase letter required.");
    }

    if (!/[a-z]/.test(trimmed)) {
      errors.push("1 lowercase letter required.");
    }

    if (!/[0-9]/.test(trimmed)) {
      errors.push("1 number required.");
    }

    if (!/[^A-Za-z0-9]/.test(trimmed)) {
      errors.push("1 symbol required.");
    }

    if (passwordValue !== trimmed) {
      errors.push("No spaces at start/end.");
    }

    const normalizedEmail = String(emailValue ?? "").trim().toLowerCase();
    const emailLocal = normalizedEmail.split("@")[0];

    if (emailLocal && trimmed.toLowerCase().includes(emailLocal)) {
      errors.push("Cannot contain your email.");
    }

    return errors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDetails([]);
    setSubmitting(true);

    try {
      const org = organizationName.trim();
      const fullName = name.trim();
      const normalizedEmail = email.trim().toLowerCase();

      if (!org || !fullName || !normalizedEmail || !password || !phone.trim()) {
        setError("Please complete all required fields.");
        setSubmitting(false);
        return;
      }

      const passwordErrors = validatePassword(password, normalizedEmail);

      if (passwordErrors.length > 0) {
        setError("Password does not meet security requirements.");
        setDetails(passwordErrors);
        setSubmitting(false);
        return;
      }

      const safeLocks = Math.max(1, Number(locks || 1));

      const res = await fetch(`${API_BASE}/api/public/signup-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationName: org,
          fullName,
          email: normalizedEmail,
          phone: phone.trim(),
          password,
          locks: safeLocks,
        }),
      });

      const data = (await res.json()) as SignupCheckoutResponse;

      if (!res.ok || !data?.url) {
        setDetails(Array.isArray(data?.details) ? data.details : []);
        throw new Error(data?.error ?? "Could not start checkout");
      }

      window.location.href = data.url;
    } catch (e: any) {
      console.error("signup checkout failed", e);
      setError(e?.message ?? "Could not start signup");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: 20,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.08)",
          padding: 28,
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: "#111827",
              marginBottom: 6,
            }}
          >
            Pin&Go
          </div>

          <div
            style={{
              fontSize: 14,
              color: "#6b7280",
              lineHeight: 1.5,
            }}
          >
            Create your Pin&amp;Go organization, continue to secure checkout, and
            activate your account after payment.
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Organization name
            </label>
            <input
              type="text"
              placeholder="Pin&Go Rentals"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Full name
            </label>
            <input
              type="text"
              placeholder="Freddie"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Email
            </label>
            <input
              type="email"
              placeholder="owner@pingo.dev"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Phone
            </label>
            <input
              type="tel"
              placeholder="7875551234"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Password
            </label>
            <input
              type="password"
              placeholder="Create a password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div
            style={{
              borderRadius: 12,
              background: "#f8fafc",
              border: "1px solid #e5e7eb",
              color: "#475569",
              fontSize: 13,
              padding: "10px 12px",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, color: "#111827", marginBottom: 4 }}>
              Password requirements
            </div>
            <div>• At least 12 characters</div>
            <div>• 1 uppercase letter</div>
            <div>• 1 lowercase letter</div>
            <div>• 1 number</div>
            <div>• 1 symbol</div>
            <div>• No spaces at start/end</div>
            <div>• Cannot contain your email</div>
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 6,
              }}
            >
              Number of locks
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={locks}
              onChange={(e) => setLocks(Math.max(1, Number(e.target.value || 1)))}
              style={{
                width: "100%",
                height: 44,
                borderRadius: 12,
                border: "1px solid #d1d5db",
                padding: "0 14px",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div
            style={{
              borderRadius: 12,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1d4ed8",
              fontSize: 13,
              padding: "10px 12px",
              lineHeight: 1.5,
            }}
          >
            Your account will be activated after secure checkout is completed.
          </div>

          {error ? (
            <div
              style={{
                borderRadius: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: 13,
                padding: "10px 12px",
              }}
            >
              <div>{error}</div>
              {details.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  {details.map((item) => (
                    <div key={item}>• {item}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            style={{
              height: 46,
              borderRadius: 12,
              border: "none",
              background: submitting ? "#93c5fd" : "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              cursor: submitting ? "not-allowed" : "pointer",
              marginTop: 4,
            }}
          >
            {submitting ? "Redirecting to checkout..." : "Continue to secure checkout"}
          </button>
        </form>

        <div
          style={{
            marginTop: 18,
            fontSize: 13,
            color: "#6b7280",
            textAlign: "center",
          }}
        >
          Already have an account?{" "}
          <Link
            to="/login"
            style={{
              color: "#2563eb",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}