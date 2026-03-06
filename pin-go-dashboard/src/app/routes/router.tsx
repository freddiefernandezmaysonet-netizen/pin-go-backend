import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell";
import { OverviewPage } from "../../pages/overview/OverviewPage";

function Placeholder({ title }: { title: string }) {
  return <div style={{ color: "#666", fontSize: 14 }}>{title} (next)</div>;
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/properties", element: <Placeholder title="Properties" /> },
      { path: "/locks", element: <Placeholder title="Locks" /> },
      { path: "/reservations", element: <Placeholder title="Reservations" /> },
      { path: "/access", element: <Placeholder title="Access" /> },
    ],
  },
]);