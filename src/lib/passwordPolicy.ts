const COMMON_PASSWORDS = new Set([
  "password",
  "password123",
  "12345678",
  "123456789",
  "qwerty",
  "qwerty123",
  "admin123",
  "welcome123",
  "letmein",
  "abc123456",
]);

export type PasswordPolicyContext = {
  email?: string | null;
  fullName?: string | null;
  organizationName?: string | null;
};

export type PasswordPolicyResult = {
  ok: boolean;
  errors: string[];
};

function normalize(value?: string | null) {
  return String(value ?? "").trim().toLowerCase();
}

export function validatePasswordPolicy(
  rawPassword: string,
  ctx: PasswordPolicyContext = {}
): PasswordPolicyResult {
  const password = String(rawPassword ?? "").trim();
  const errors: string[] = [];

  if (password.length < 12) {
    errors.push("At least 12 characters.");
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("1 uppercase letter required.");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("1 lowercase letter required.");
  }

  if (!/[0-9]/.test(password)) {
    errors.push("1 number required.");
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("1 symbol required.");
  }

  const normalizedPassword = normalize(password);

  if (COMMON_PASSWORDS.has(normalizedPassword)) {
    errors.push("Password too common.");
  }

  const email = normalize(ctx.email);
  if (email) {
    const emailLocal = email.split("@")[0];
    if (emailLocal && normalizedPassword.includes(emailLocal)) {
      errors.push("Cannot contain your email.");
    }
  }

  if (rawPassword !== password) {
    errors.push("No spaces at start/end.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}