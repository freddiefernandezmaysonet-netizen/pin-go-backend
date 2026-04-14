import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

export type AuthTokenPayload = {
  sub: string;
  orgId: string;
  email: string;
  role?: string;
  tokenVersion: number;
};

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? "pingo_token";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

function getJwtSecret() {
  const value = String(JWT_SECRET ?? "").trim();

  if (!value || value.length < 32) {
    throw new Error("JWT_SECRET is missing or too weak");
  }

  return value;
}

function getCookieDomain() {
  const value = String(COOKIE_DOMAIN ?? "").trim();
  return value || null;
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

  if (
    !payload.sub ||
    !payload.orgId ||
    !payload.email ||
    typeof payload.tokenVersion !== "number"
  ) {
    throw new Error("Token missing required fields");
  }

  return {
    sub: payload.sub,
    orgId: payload.orgId,
    email: payload.email,
    role: payload.role,
    tokenVersion: payload.tokenVersion,
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
  const sameSite = isProd ? "None" : "Lax";
  const cookieDomain = getCookieDomain();

  const parts = [
    `${getAuthCookieName()}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];

  if (isProd) {
    parts.push("Secure");
  }

  if (isProd && cookieDomain) {
    parts.push(`Domain=${cookieDomain}`);
  }

  return parts.join("; ");
}

export function buildClearAuthCookie() {
  const isProd = process.env.NODE_ENV === "production";
  const sameSite = isProd ? "None" : "Lax";
  const cookieDomain = getCookieDomain();

  const parts = [
    `${getAuthCookieName()}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ];

  if (isProd) {
    parts.push("Secure");
  }

  if (isProd && cookieDomain) {
    parts.push(`Domain=${cookieDomain}`);
  }

  return parts.join("; ");
}