import { Outlet, NavLink } from "react-router-dom";
import { LayoutDashboard, Building2, Lock, CalendarDays, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { useMe } from "@/api/hooks";

const nav = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/properties", label: "Properties", icon: Building2 },
  { to: "/locks", label: "Locks", icon: Lock },
  { to: "/reservations", label: "Reservations", icon: CalendarDays },
  { to: "/access", label: "Access", icon: KeyRound },
];

function SideLink({ to, label, icon: Icon }: any) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
          isActive
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const { data: me } = useMe();

  return (
    <div className="min-h-screen bg-background">
      <div className="grid lg:grid-cols-[260px_1fr]">
        {/* sidebar igual */}

        <div className="min-w-0">
          <header className="h-16 border-b flex items-center justify-between px-4">
            <div className="text-sm text-muted-foreground">
              Organization:{" "}
              <span className="text-foreground font-medium">
                {me?.orgName ?? "—"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">{me?.email ?? ""}</div>
          </header>

          <main className="p-4 lg:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
