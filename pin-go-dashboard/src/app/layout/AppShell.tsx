import { NavLink, Outlet } from "react-router-dom";

const nav = [
  { to: "/overview", label: "Overview" },
  { to: "/properties", label: "Properties" },
  { to: "/locks", label: "Locks" },
  { to: "/reservations", label: "Reservations" },
  { to: "/access", label: "Access" },
];

export function AppShell() {
  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", minHeight: "100vh" }}>
        <aside style={{ borderRight: "1px solid #e5e7eb", padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 20 }}>
            Pin&Go
          </div>

          <nav style={{ display: "grid", gap: 8 }}>
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                style={({ isActive }) => ({
                  padding: "10px 12px",
                  borderRadius: 10,
                  textDecoration: "none",
                  color: isActive ? "#111" : "#666",
                  background: isActive ? "#f3f4f6" : "transparent",
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div>
          <header
            style={{
              height: 64,
              borderBottom: "1px solid #e5e7eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
            }}
          >
            <div style={{ color: "#666", fontSize: 14 }}>Pin&Go Control Center</div>
            <div style={{ color: "#666", fontSize: 12 }}>
              API: {import.meta.env.VITE_API_BASE ?? "http://localhost:3000"}
            </div>
          </header>

          <main style={{ padding: 24 }}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}