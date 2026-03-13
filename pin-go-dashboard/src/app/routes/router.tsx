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
import { PmsConnectionsPage } from "../../pages/integrations/PmsConnectionsPage";
import ListingsMappingPage from "../../pages/pms/ListingsMappingPage";
import LoginPage from "../../pages/LoginPage";

import { RequireAuth } from "../../auth/RequireAuth";
import CreatePropertyPage from "../../pages/onboarding/CreatePropertyPage";
import TtlockConnectPage from "../../pages/integrations/TtlockConnectPage";
import NfcSyncPage from "../../pages/dashboard/locks/NfcSyncPage";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/onboarding/property", element: <CreatePropertyPage /> },
      { path: "/overview", element: <OverviewPage /> },

      { path: "/properties", element: <PropertiesPage /> },
      { path: "/properties/:id", element: <PropertyDetailPage /> },

      { path: "/locks", element: <LocksPage /> },
      { path: "/locks/nfc-sync", element: <NfcSyncPage /> },
      { path: "/locks/:id", element: <LockDetailPage /> },

      { path: "/reservations", element: <ReservationsPage /> },
      { path: "/reservations/:id", element: <ReservationDetailPage /> },

      { path: "/access", element: <AccessPage /> },

      { path: "/integrations/pms", element: <PmsConnectionsPage /> },
      { path: "/integrations/ttlock", element: <TtlockConnectPage /> },
      { path: "/integrations/pms/listings-mapping", element: <ListingsMappingPage /> },
    ],
  },
]);