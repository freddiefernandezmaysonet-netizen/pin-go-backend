const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export async function fetchMe() {
  const res = await fetch(`${API_BASE}/auth/me`, {
    credentials: "include",
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  return data.user;
}

export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error("Login failed");
  }

  return res.json();
}

export async function logout() {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

/**
 * Crear organización + usuario administrador
 * El backend automáticamente crea la cookie de sesión
 */
export async function registerOrganization(input: {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  role?: "ADMIN" | "MEMBER";
}) {
  const res = await fetch(`${API_BASE}/api/auth/register-organization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      organizationName: input.organizationName,
      name: input.name,
      email: input.email,
      password: input.password,
      role: input.role ?? "ADMIN",
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.error ?? "REGISTER_ORGANIZATION_FAILED");
  }

  return data;
}