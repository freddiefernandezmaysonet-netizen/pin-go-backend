import { useAuth } from "./AuthProvider";

export function useOrg() {
  const { user, loading } = useAuth();

  return {
    orgId: user?.orgId ?? null,
    user,
    loading,
    isReady: !loading && !!user?.orgId,
  };
}