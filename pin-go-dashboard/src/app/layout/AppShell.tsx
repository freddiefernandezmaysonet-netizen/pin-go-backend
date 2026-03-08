import { NavLink, Outlet } from "react-router-dom";

const nav = [
  { to: "/overview", label: "Overview" },
  { to: "/properties", label: "Properties" },
  { to: "/locks", label: "Locks" },
  { to: "/reservations", label: "Reservations" },
  { to: "/access", label: "Access" },
  { to: "/integrations/pms", label: "PMS Connections" },
];

function SideItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        padding: "10px 12px",
        borderRadius: 12,
        textDecoration: "none",
        color: isActive ? "#111827" : "#6b7280",
        background: isActive ? "#f3f4f6" : "transparent",
        fontWeight: isActive ? 600 : 500,
        display: "block",
      })}
    >
      {label}
    </NavLink>
  );
}

export function AppShell() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        color: "#111827",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px 1fr",
          minHeight: "100vh",
        }}
      >
        {/* Sidebar */}
        <aside
          style={{
            borderRight: "1px solid #e5e7eb",
            background: "#ffffff",
            padding: 20,
            display: "grid",
            gridTemplateRows: "auto 1fr auto",
            gap: 20,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: "-0.03em",
              }}
            >
              Pin&Go
            </div>
            <div style={{ color: "#6b7280", fontSize: 13, marginTop: 4 }}>
              Control Center
            </div>
          </div>

          <nav style={{ display: "grid", gap: 8, alignContent: "start" }}>
            {nav.map((item) => (
              <SideItem key={item.to} to={item.to} label={item.label} />
            ))}
          </nav>

          <div
            style={{
              borderTop: "1px solid #f3f4f6",
              paddingTop: 14,
              color: "#6b7280",
              fontSize: 12,
            }}
          >
            Pin&Go Dashboard v1
          </div>
        </aside>

        {/* Main */}
        <div style={{ display: "grid", gridTemplateRows: "64px 1fr" }}>
          {/* Topbar */}
          <header
            style={{
              borderBottom: "1px solid #e5e7eb",
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 20px",
            }}
          >
            <div>
              <div style={{ fontSize: 14, color: "#6b7280" }}>
                Pin&Go Operations
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#6b7280" }}>
              Live Dashboard
            </div>
          </header>

          {/* Content */}
          <main style={{ padding: 24 }}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}