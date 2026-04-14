import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "../../api/password";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDetails([]);
    setSuccess("");
    setSubmitting(true);

    if (!token) {
      setError("Invalid or expired reset link.");
      setSubmitting(false);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setSubmitting(false);
      return;
    }

    try {
      const result = await resetPassword(token, password);

      if (!result.ok) {
        setError(result.error || "Unable to reset password.");
        setDetails(result.details || []);
        return;
      }

      setSuccess(result.message || "Password updated successfully.");

      setTimeout(() => {
        navigate("/login");
      }, 1500);
    } catch (e) {
      setError("Unable to reset password.");
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
          maxWidth: 420,
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
            Create a new secure password for your account.
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
              New password
            </label>
            <input
              type="password"
              placeholder="Enter your new password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
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
              Confirm new password
            </label>
            <input
              type="password"
              placeholder="Confirm your new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
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

          {success ? (
            <div
              style={{
                borderRadius: 12,
                background: "#ecfdf5",
                border: "1px solid #a7f3d0",
                color: "#047857",
                fontSize: 13,
                padding: "10px 12px",
              }}
            >
              {success}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting || !token}
            style={{
              height: 46,
              borderRadius: 12,
              border: "none",
              background: submitting || !token ? "#93c5fd" : "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              cursor: submitting || !token ? "not-allowed" : "pointer",
              marginTop: 4,
            }}
          >
            {submitting ? "Updating..." : "Update password"}
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
          Back to{" "}
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