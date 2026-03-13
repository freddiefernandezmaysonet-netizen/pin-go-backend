export function getOrganizationId(): string | null {
  try {
    const fromLocal =
      localStorage.getItem("organizationId") ||
      localStorage.getItem("orgId");

    if (fromLocal) return fromLocal;

    const fromSession =
      sessionStorage.getItem("organizationId") ||
      sessionStorage.getItem("orgId");

    if (fromSession) return fromSession;

    return null;
  } catch {
    return null;
  }
}