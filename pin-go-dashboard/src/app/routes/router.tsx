import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell";
import { OverviewPage } from "../../pages/overview/OverviewPage";
import { ReservationsPage } from "../../pages/reservations/ReservationsPage";
import { LocksPage } from "../../pages/locks/LocksPage";
import { AccessPage } from "../../pages/access/AccessPage";

function Placeholder({ title }: { title: string }) {
  return <div style={{ color: "#666", fontSize: 14 }}>{title} (next)</div>;
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/reservations", element: <ReservationsPage /> },
      { path: "/locks", element: <LocksPage /> },
      { path: "/properties", element: <Placeholder title="Properties" /> },
      { path: "/access", element: <AccessPage /> },
    ],
  },
]);