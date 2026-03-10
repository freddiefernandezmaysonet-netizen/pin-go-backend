// src/lib/auth.ts
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

export type AuthTokenPayload = {
  sub: string;          // userId
  orgId: string;        // organizationId
  email: string;
  role?: string;
};

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-this";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? "pingo_token";

function getJwtSecret() {
  if (!JWT_SECRET || JWT_SECRET.trim().length < 8) {
    throw new Error("JWT_SECRET is missing or too weak");
  }
  return JWT_SECRET;
}

export function getAuthCookieName() {
  return AUTH_COOKIE_NAME;
}

export function signAuthToken(payload: AuthTokenPayload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, getJwtSecret());

  if (!decoded || typeof decoded === "string") {
    throw new Error("Invalid token payload");
  }

  const payload = decoded as Partial<AuthTokenPayload>;

  if (!payload.sub || !payload.orgId || !payload.email) {
    throw new Error("Token missing required fields");
  }

  return {
    sub: payload.sub,
    orgId: payload.orgId,
    email: payload.email,
    role: payload.role,
  };
}

export async function hashPassword(password: string) {
  const value = String(password ?? "").trim();

  if (value.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  return bcrypt.hash(value, 10);
}

export async function comparePassword(password: string, passwordHash: string) {
  return bcrypt.compare(String(password ?? ""), String(passwordHash ?? ""));
}

export function extractBearerToken(authHeader?: string | null) {
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(" ");

  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;

  return token.trim();
}

export function parseCookieHeader(cookieHeader?: string | null) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;

  const parts = cookieHeader.split(";");

  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;

    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();

    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }

  return out;
}

export function extractTokenFromRequest(req: {
  headers?: Record<string, unknown>;
}) {
  const headers = req.headers ?? {};

  const authHeader =
    typeof headers.authorization === "string"
      ? headers.authorization
      : null;

  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;

  const cookieHeader =
    typeof headers.cookie === "string"
      ? headers.cookie
      : null;

  const cookies = parseCookieHeader(cookieHeader);
  const cookieToken = cookies[getAuthCookieName()];

  return cookieToken ?? null;
}

export function buildAuthCookie(token: string) {
  const isProd = process.env.NODE_ENV === "production";

  const parts = [
    `${getAuthCookieName()}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];

  if (isProd) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function buildClearAuthCookie() {
  const isProd = process.env.NODE_ENV === "production";

  const parts = [
    `${getAuthCookieName()}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (isProd) {
    parts.push("Secure");
  }

  return parts.join("; ");
}