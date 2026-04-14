import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE;

export default function AdminFinancialPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`${API}/api/admin/financial/overview`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then(setData);
  }, []);

  if (!data) return <div>Loading...</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2>Admin Financial Dashboard</h2>

      <h3>Platform Summary</h3>
      <p>Organizations: {data.summary.totalOrgs}</p>
      <p>Locks: {data.summary.totalLocks}</p>
      <p>Smart Properties: {data.summary.totalSmart}</p>

      <h3>Revenue</h3>
      <p>Total: ${data.revenue.total.toFixed(2)}</p>

      <h3>Costs</h3>
      <p>Total: ${data.costs.total.toFixed(2)}</p>

      <h3>Profit</h3>
      <p>Net: ${data.profit.net.toFixed(2)}</p>
      <p>Margin: {data.profit.margin.toFixed(2)}%</p>
    </div>
  );
}