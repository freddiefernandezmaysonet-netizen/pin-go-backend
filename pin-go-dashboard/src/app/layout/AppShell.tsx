import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { logout } from "../../api/auth";
import { useAuth } from "../../auth/AuthProvider";

const nav = [
  { to: "/overview", label: "Overview" },
  { to: "/properties", label: "Properties" },
  { to: "/locks", label: "Locks" },
  { to: "/health", label: "Locks Health Center" },
  { to: "/reservations", label: "Reservations" },
  { to: "/access", label: "Access" },
  
   // 👇 NUEVO
  { to: "/messages", label: "Messages" },
  { to: "/staff", label: "Staff Members" },

  { to: "/integrations/pms", label: "PMS" },
  { to: "/billing", label: "Billing" },
  { to: "/integrations/tuya", label: "Tuya Integration" },
  { to: "/automation/history", label: "Automation History" },
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

function getPageTitle(pathname: string) {
  if (pathname.startsWith("/overview")) return "Overview";
  if (pathname.startsWith("/properties")) return "Properties";
  if (pathname.startsWith("/locks")) return "Locks";
  if (pathname.startsWith("/reservations")) return "Reservations";
  if (pathname.startsWith("/access")) return "Access";
  if (pathname.startsWith("/staff")) return "Staff Members";
  if (pathname.startsWith("/health")) return "Health Center";
  if (pathname.startsWith("/automation/history")) return "Automation History";

  // 👇 NUEVO
  if (pathname.startsWith("/messages")) return "Messages";

  if (pathname.startsWith("/integrations/pms")) return "PMS Integrations";
  if (pathname.startsWith("/billing")) return "Billing";
  if (pathname.startsWith("/integrations/tuya")) return "Tuya Integration";

  return "Dashboard";
}

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  async function handleLogout() {
    try {
      await logout();
    } finally {
      navigate("/login");
    }
  }

  const pageTitle = getPageTitle(location.pathname);

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
          display: "flex",
          flexDirection: "column",
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

        <div style={{ flex: 1 }} />

        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: "1px solid #e5e7eb",
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#6b7280",
              marginBottom: 8,
              wordBreak: "break-word",
            }}
          >
            {user?.email ?? "No user"}
          </div>

          <button
            onClick={handleLogout}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              background: "#fff",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Log out
          </button>
        </div>
      </aside>

      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header
          style={{
            height: 72,
            borderBottom: "1px solid #e5e7eb",
            background: "rgba(255,255,255,0.9)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 24px",
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111827",
                lineHeight: 1.1,
              }}
            >
              {pageTitle}
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#6b7280",
                marginTop: 4,
              }}
            >
              Pin&Go Dashboard
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
             <div style={{ textAlign: "right" }}>
    <div
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: "#111827",
      }}
    >
    {user?.organizationName ?? "Organization"}   
  </div>
  </div>

            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 999,
                background: "#dbeafe",
                color: "#1d4ed8",
                display: "grid",
                placeItems: "center",
                fontWeight: 800,
                fontSize: 14,
                border: "1px solid #bfdbfe",
              }}
            >
              {(user?.email?.[0] ?? "P").toUpperCase()}
            </div>
          </div>
        </header>

        <main style={{ padding: 24 }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}