import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function RequireGuest({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (user) {
    return <Navigate to="/overview" replace />;
  }

  return children;
}