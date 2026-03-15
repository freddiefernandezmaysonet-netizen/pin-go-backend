import { useNavigate } from "react-router-dom";

export default function BillingCancelPage() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: 40 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>
        Checkout Cancelled
      </h1>

      <p style={{ marginTop: 10 }}>
        Your billing session was cancelled.
      </p>

      <button
        onClick={() => navigate("/billing")}
        style={{
          marginTop: 20,
          padding: "10px 16px",
          background: "#111827",
          color: "#fff",
          borderRadius: 8,
          border: "none",
          cursor: "pointer"
        }}
      >
        Return to Billing
      </button>
    </div>
  );
}