import { NavLink, Outlet } from "react-router-dom";

const nav = [
  { to: "/overview", label: "Overview" },
  { to: "/properties", label: "Properties" },
  { to: "/locks", label: "Locks" },
  { to: "/reservations", label: "Reservations" },
  { to: "/access", label: "Access" },
  { to: "/integrations/pms", label: "PMS" },
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
        display: "grid",
        gridTemplateColumns: "240px 1fr",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid #e5e7eb",
          background: "#ffffff",
          padding: 16,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            marginBottom: 20,
          }}
        >
          Pin&Go
        </div>

        <nav style={{ display: "grid", gap: 8 }}>
          {nav.map((item) => (
            <SideItem key={item.to} to={item.to} label={item.label} />
          ))}
        </nav>
      </aside>

      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}