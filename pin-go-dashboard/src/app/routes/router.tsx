import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell";
import { OverviewPage } from "../../pages/overview/OverviewPage";
import { ReservationsPage } from "../../pages/reservations/ReservationsPage";
import { ReservationDetailPage } from "../../pages/reservation-detail/ReservationDetailPage";
import { LocksPage } from "../../pages/locks/LocksPage";
import { AccessPage } from "../../pages/access/AccessPage";
import { PropertiesPage } from "../../pages/properties/PropertiesPage";
import { PropertyDetailPage } from "../../pages/property-detail/PropertyDetailPage";
import { PropertyEditPage } from "../../pages/properties/PropertyEditPage";
import { LockDetailPage } from "../../pages/lock-detail/LockDetailPage";
import { PmsConnectionsPage } from "../../pages/integrations/PmsConnectionsPage";
import TuyaIntegrationPremiumPage from "../../pages/integrations/TuyaIntegrationPremiumPage";
import TuyaIntegrationPage from "../../pages/integrations/TuyaIntegrationPage";
import ListingsMappingPage from "../../pages/pms/ListingsMappingPage";
import LoginPage from "../../pages/LoginPage";
import SignupPage from "../../pages/auth/SignupPage";
import SignupSuccessPage from "../../pages/auth/SignupSuccessPage";
import { RequireAuth } from "../../auth/RequireAuth";
import CreatePropertyPage from "../../pages/onboarding/CreatePropertyPage";
import TtlockConnectPage from "../../pages/integrations/TtlockConnectPage";
import NfcSyncPage from "../../pages/dashboard/locks/NfcSyncPage";
import { BillingPage } from "../../pages/dashboard/BillingPage";
import BillingSuccessPage from "../../pages/dashboard/BillingSuccessPage";
import BillingCancelPage from "../../pages/dashboard/BillingCancelPage";
import { HealthCenterPage } from "../../pages/health-center/HealthCenterPage";
import { StaffMembersPage } from "../../pages/staff/StaffMembersPage";
import ForgotPasswordPage from "../../pages/auth/ForgotPasswordPage";
import ResetPasswordPage from "../../pages/auth/ResetPasswordPage";
import AutomationHistoryPage from "../../pages/AutomationHistoryPage";
import MessagesPage from "../../pages/messages/MessagesPage";
import AdminFinancialPage from "../../pages/admin/AdminFinancialPage";
import LandingPage from "../../pages/LandingPage";
import TermsPage from "../../pages/TermsPage";
import PrivacyPage from "../../pages/PrivacyPage";


export const router = createBrowserRouter([
 
  {
  path: "/home",
  element: <LandingPage />,
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/signup",
    element: <SignupPage />,
  },
  { 
    path: "/legal/terms",
    element: <TermsPage /> 
  },
  { 
    path: "/legal/privacy",
    element: <PrivacyPage /> 
  },
  {
    path: "/signup/success",
    element: <SignupSuccessPage />,
  },
  {
    path: "/forgot-password",
    element: <ForgotPasswordPage />,
  },
  {
    path: "/reset-password",
    element: <ResetPasswordPage />,
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
      { path: "/properties/:id/edit", element: <PropertyEditPage /> },

      { path: "/locks", element: <LocksPage /> },
      { path: "/locks/nfc-sync", element: <NfcSyncPage /> },
      { path: "/locks/:id", element: <LockDetailPage /> },

      { path: "/reservations", element: <ReservationsPage /> },
      { path: "/reservations/:id", element: <ReservationDetailPage /> },

      { path: "/access", element: <AccessPage /> },
      { path: "/staff", element: <StaffMembersPage /> },

      { path: "/health", element: <HealthCenterPage /> },
      { path: "/automation/history", element: <AutomationHistoryPage /> },
      { path: "/messages", element: <MessagesPage /> },
           
      { path: "/billing", element: <BillingPage /> },
      { path: "/billing/success", element: <BillingSuccessPage /> },
      { path: "/billing/cancel", element: <BillingCancelPage /> },

      { path: "/integrations/pms", element: <PmsConnectionsPage /> },
      { path: "/integrations/ttlock", element: <TtlockConnectPage /> },
      { path: "/integrations/tuya-premium", element: <TuyaIntegrationPremiumPage /> },
      { path: "/integrations/tuya", element: <TuyaIntegrationPage /> },
      { path: "/integrations/pms/listings-mapping", element: <ListingsMappingPage /> },
    ],
  },

 {
    path: "/admin/financial",
    element: (
      <RequireAuth>
        <AdminFinancialPage />
      </RequireAuth>
    ),
  },
]);