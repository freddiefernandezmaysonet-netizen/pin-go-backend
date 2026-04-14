import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE;

export default function FinancialDashboard() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`${API}/api/org/financial/overview`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then(setData);
  }, []);

  if (!data) return <div>Loading...</div>;

  return (
    <div style={{ padding: 20 }}>
      <h2>Financial Overview</h2>

      <h3>Revenue</h3>
      <p>Locks: ${data.revenue.locks.toFixed(2)}</p>
      <p>Smart: ${data.revenue.smart.toFixed(2)}</p>
      <p>Total: ${data.revenue.total.toFixed(2)}</p>

      <h3>Usage</h3>
      <p>Active Locks: {data.usage.activeLocks}</p>
      <p>Smart Properties: {data.usage.activeSmart}</p>

      <h3>Costs</h3>
      <p>Stripe: ${data.costs.stripe.toFixed(2)}</p>
      <p>Twilio: ${data.costs.twilio.toFixed(2)}</p>
      <p>Tuya: ${data.costs.tuya.toFixed(2)}</p>
      <p>Total: ${data.costs.total.toFixed(2)}</p>

      <h3>Profit</h3>
      <p>Net: ${data.profit.net.toFixed(2)}</p>
      <p>Margin: {data.profit.margin.toFixed(2)}%</p>
    </div>
  );
}