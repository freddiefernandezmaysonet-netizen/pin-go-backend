import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell";
import { OverviewPage } from "../../pages/overview/OverviewPage";
import { ReservationsPage } from "../../pages/reservations/ReservationsPage";
import { ReservationDetailPage } from "../../pages/reservation-detail/ReservationDetailPage";
import { LocksPage } from "../../pages/locks/LocksPage";
import { AccessPage } from "../../pages/access/AccessPage";
import { PropertiesPage } from "../../pages/properties/PropertiesPage";
import { PropertyDetailPage } from "../../pages/property-detail/PropertyDetailPage";
import { LockDetailPage } from "../../pages/lock-detail/LockDetailPage";

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/overview", element: <OverviewPage /> },

      { path: "/properties", element: <PropertiesPage /> },
      { path: "/properties/:id", element: <PropertyDetailPage /> },

      { path: "/locks", element: <LocksPage /> },
      { path: "/locks/:id", element: <LockDetailPage /> },

      { path: "/reservations", element: <ReservationsPage /> },
      { path: "/reservations/:id", element: <ReservationDetailPage /> },

      { path: "/access", element: <AccessPage /> },
    ],
  },
]);