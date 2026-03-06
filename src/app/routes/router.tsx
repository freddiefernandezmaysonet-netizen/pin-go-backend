import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell";

import { OverviewPage } from "@/pages/overview/OverviewPage";
import { PropertiesPage } from "@/pages/properties/PropertiesPage";
import { LocksPage } from "@/pages/locks/LocksPage";
import { ReservationsPage } from "@/pages/reservations/ReservationsPage";
import { AccessPage } from "@/pages/access/AccessPage";

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/properties", element: <PropertiesPage /> },
      { path: "/locks", element: <LocksPage /> },
      { path: "/reservations", element: <ReservationsPage /> },
      { path: "/access", element: <AccessPage /> },
    ],
  },
]);