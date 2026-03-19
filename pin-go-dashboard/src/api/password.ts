const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type ForgotPasswordResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

export type ResetPasswordResponse = {
  ok: boolean;
  message?: string;
  error?: string;
  details?: string[];
};

export async function forgotPassword(email: string): Promise<ForgotPasswordResponse> {
  const resp = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      email: String(email ?? "").trim().toLowerCase(),
    }),
  });

  const data = await resp.json().catch(() => ({}));

  return {
    ok: !!data?.ok,
    message: data?.message,
    error: data?.error,
  };
}

export async function resetPassword(
  token: string,
  password: string
): Promise<ResetPasswordResponse> {
  const resp = await fetch(`${API_BASE}/auth/reset-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      token: String(token ?? "").trim(),
      password,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  return {
    ok: !!data?.ok,
    message: data?.message,
    error: data?.error,
    details: Array.isArray(data?.details) ? data.details : [],
  };
}