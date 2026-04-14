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
      setError(e?.message ?? "Could not start signup");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, rgba(37, 99, 235, 0.08), transparent 28%), linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1080,
          display: "grid",
          gridTemplateColumns: "1.05fr 0.95fr",
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: 24,
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.10)",
          overflow: "hidden",
        }}
      >
        {/* LEFT BRAND PANEL */}
        <div
          style={{
            background:
              "linear-gradient(180deg, #0f172a 0%, #111827 55%, #1e293b 100%)",
            color: "#ffffff",
            padding: 36,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minHeight: 720,
          }}
        >
          <div>
            <Link
              to="/home"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 12,
                textDecoration: "none",
                color: "#ffffff",
              }}
            >
              <img
                src="/pin-go-logo.png"
                alt="Pin&Go logo"
                style={{
                  width: 48,
                  height: 48,
                  objectFit: "contain",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.08)",
                  padding: 6,
                }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              <div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>Pin&Go</div>
                <div style={{ fontSize: 13, color: "#cbd5e1" }}>
                  Control total para propiedades inteligentes
                </div>
              </div>
            </Link>

            <div style={{ marginTop: 40 }}>
              <div
                style={{
                  display: "inline-block",
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#e2e8f0",
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: "8px 12px",
                }}
              >
                Automate access. Reduce operational friction.
              </div>

              <h1
                style={{
                  marginTop: 18,
                  marginBottom: 14,
                  fontSize: 42,
                  lineHeight: 1.05,
                  fontWeight: 800,
                }}
              >
                Start selling a smarter guest experience from day one
              </h1>

              <p
                style={{
                  fontSize: 17,
                  lineHeight: 1.7,
                  color: "#cbd5e1",
                  maxWidth: 480,
                }}
              >
                Create your organization, choose your lock count, and continue
                to secure checkout to activate Pin&Go.
              </p>
            </div>

            <div
              style={{
                marginTop: 30,
                display: "grid",
                gap: 14,
              }}
            >
              <FeatureItem text="Automatic access codes by reservation" />
              <FeatureItem text="NFC-enabled guest access workflows" />
              <FeatureItem text="PMS + lock + automation in one platform" />
              <FeatureItem text="Simple pricing at $9.99 per lock / month" />
            </div>
          </div>

          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.10)",
              paddingTop: 20,
              color: "#cbd5e1",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            Trusted workflow for modern property operations.
          </div>
        </div>

        {/* RIGHT FORM PANEL */}
        <div
          style={{
            padding: 32,
            background: "#ffffff",
          }}
        >
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: "#111827",
                marginBottom: 8,
              }}
            >
              Create your account
            </div>

            <div
              style={{
                fontSize: 14,
                color: "#6b7280",
                lineHeight: 1.6,
              }}
            >
              Set up your organization and continue to secure checkout to
              activate your Pin&amp;Go account.
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
            <Field
              label="Organization name"
              input={
                <input
                  type="text"
                  placeholder="Pin&Go Rentals"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  style={inputStyle}
                />
              }
            />

            <Field
              label="Full name"
              input={
                <input
                  type="text"
                  placeholder="Freddie"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={inputStyle}
                />
              }
            />

            <Field
              label="Email"
              input={
                <input
                  type="email"
                  placeholder="owner@pingo.dev"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  style={inputStyle}
                />
              }
            />

            <Field
              label="Phone"
              input={
                <input
                  type="tel"
                  placeholder="7875551234"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  style={inputStyle}
                />
              }
            />

            <Field
              label="Password"
              input={
                <input
                  type="password"
                  placeholder="Create a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  style={inputStyle}
                />
              }
            />

            <div
              style={{
                borderRadius: 14,
                background: "#f8fafc",
                border: "1px solid #e5e7eb",
                color: "#475569",
                fontSize: 13,
                padding: "12px 14px",
                lineHeight: 1.7,
              }}
            >
              <div
                style={{
                  fontWeight: 800,
                  color: "#111827",
                  marginBottom: 6,
                }}
              >
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

            <Field
              label="Number of locks"
              input={
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={locks}
                  onChange={(e) =>
                    setLocks(Math.max(1, Number(e.target.value || 1)))
                  }
                  style={inputStyle}
                />
              }
            />

            <div
              style={{
                borderRadius: 14,
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                color: "#1d4ed8",
                fontSize: 13,
                padding: "12px 14px",
                lineHeight: 1.6,
              }}
            >
              Your account will be activated after secure checkout is completed.
            </div>

            {error ? (
              <div
                style={{
                  borderRadius: 14,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                  fontSize: 13,
                  padding: "12px 14px",
                  lineHeight: 1.6,
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
                height: 48,
                borderRadius: 14,
                border: "none",
                background: submitting ? "#93c5fd" : "#2563eb",
                color: "#ffffff",
                fontSize: 14,
                fontWeight: 800,
                cursor: submitting ? "not-allowed" : "pointer",
                marginTop: 4,
                boxShadow: submitting
                  ? "none"
                  : "0 10px 24px rgba(37, 99, 235, 0.22)",
              }}
            >
   
            {submitting
                ? "Redirecting to checkout..."
                : "Continue to secure checkout"}
            </button>
          </form>

       <div
  style={{
    marginTop: 12,
    fontSize: 12,
    color: "#6b7280",
    textAlign: "center",
    lineHeight: 1.6,
  }}
>
  By continuing, you agree to our{" "}
  <Link
    to="/legal/terms"
    style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
  >
    Terms of Service
  </Link>{" "}
  and{" "}
  <Link
    to="/legal/privacy"
    style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
  >
    Privacy Policy
  </Link>.
</div>

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
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  input,
}: {
  label: string;
  input: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 700,
          color: "#374151",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {input}
    </div>
  );
}

function FeatureItem({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        color: "#e5e7eb",
        fontSize: 15,
        lineHeight: 1.6,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: 999,
          background: "rgba(255,255,255,0.10)",
          fontSize: 12,
          fontWeight: 800,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        ✓
      </span>
      <span>{text}</span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 46,
  borderRadius: 14,
  border: "1px solid #d1d5db",
  padding: "0 14px",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
  background: "#ffffff",
};