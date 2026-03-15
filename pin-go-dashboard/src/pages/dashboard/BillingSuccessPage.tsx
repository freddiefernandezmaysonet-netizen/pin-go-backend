import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export default function BillingSuccessPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const sessionId = params.get("session_id");

  useEffect(() => {
    const t = setTimeout(() => {
      navigate("/billing");
    }, 3000);

    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>
        Subscription Updated
      </h1>

      <p style={{ marginTop: 10 }}>
        Your billing subscription was successfully updated.
      </p>

      <p style={{ marginTop: 6, color: "#6b7280", fontSize: 14 }}>
        Stripe session: {sessionId}
      </p>

      <p style={{ marginTop: 20 }}>
        Redirecting back to billing...
      </p>
    </div>
  );
}