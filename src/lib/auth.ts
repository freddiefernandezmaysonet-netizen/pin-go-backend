import jwt, {
  type SignOptions,
} from "jsonwebtoken";
import bcrypt from "bcryptjs";

export type AuthTokenPayload = {
  sub: string;
  orgId: string;
  email: string;
  role?: string;
  tokenVersion: number;
};

export type AuthCookieOptions = {
  requestOrigin?: string | null;
};

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = (
  process.env.JWT_EXPIRES_IN ?? "7d"
) as SignOptions["expiresIn"];
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? "pingo_token";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;
const BRAND_HOSTNAME_HEADER = "x-pin-go-brand-hostname";
const STANDARD_PIN_GO_AUTH_HOSTNAMES = new Set([
  "app.pin-ngo.com",
  "api.pin-ngo.com",
  "pin-ngo.com",
  "www.pin-ngo.com",
  "localhost",
  "127.0.0.1",
]);

type AuthCookieScope = "STANDARD" | "BRAND";
type RequestCookieScope = AuthCookieScope | "INVALID" | "UNSPECIFIED";

function getJwtSecret() {
  const value = String(JWT_SECRET ?? "").trim();

  if (!value || value.length < 32) {
    throw new Error("JWT_SECRET is missing or too weak");
  }

  return value;
}

function getSecureOriginHostname(
  rawOrigin: string | null | undefined
): string | null {
  const origin = String(rawOrigin ?? "").trim();
  if (!origin) return null;

  const authority = origin
    .replace(/^https:\/\//i, "")
    .replace(/\/$/, "");
  if (authority.includes(":")) return null;

  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function getRequestOriginHostname(
  rawOrigin: string | null | undefined
): string | null {
  const origin = String(rawOrigin ?? "").trim();
  if (!origin) return null;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const secureOrigin = parsed.protocol === "https:";
    const localDevelopmentOrigin =
      parsed.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1");
    const authority = origin
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/\/$/, "");

    if (
      (!secureOrigin && !localDevelopmentOrigin) ||
      (secureOrigin && authority.includes(":")) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
}

function normalizeRequestHostname(
  rawHostname: string | null | undefined
): string | null {
  const hostname = String(rawHostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes(",") ||
    hostname.includes(":") ||
    hostname.includes("/") ||
    hostname.includes("\\") ||
    hostname.includes("@") ||
    /\s/.test(hostname)
  ) {
    return null;
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return hostname;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) return null;
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-")
    )
  ) {
    return null;
  }

  return hostname;
}

function cookieScopeForHostname(hostname: string): AuthCookieScope {
  return STANDARD_PIN_GO_AUTH_HOSTNAMES.has(hostname)
    ? "STANDARD"
    : "BRAND";
}

function cookieScopeForOrigin(
  requestOrigin: string | null | undefined
): AuthCookieScope {
  if (!String(requestOrigin ?? "").trim()) return "STANDARD";

  const hostname = getRequestOriginHostname(requestOrigin);
  return hostname ? cookieScopeForHostname(hostname) : "BRAND";
}

function getHeaderValue(
  headers: Record<string, unknown>,
  name: string
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function requestCookieScope(
  headers: Record<string, unknown>
): RequestCookieScope {
  const rawOrigin = getHeaderValue(headers, "origin");
  if (rawOrigin !== null) {
    const originHostname = getRequestOriginHostname(rawOrigin);
    return originHostname
      ? cookieScopeForHostname(originHostname)
      : "INVALID";
  }

  const rawBrandHostname = getHeaderValue(
    headers,
    BRAND_HOSTNAME_HEADER
  );
  if (rawBrandHostname !== null) {
    const brandHostname = normalizeRequestHostname(rawBrandHostname);
    return brandHostname
      ? cookieScopeForHostname(brandHostname)
      : "INVALID";
  }

  return "UNSPECIFIED";
}

function normalizeCookieDomainForComparison(
  rawDomain: string
): string | null {
  const normalized = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/\.$/, "");

  if (!normalized || normalized.includes("..")) return null;

  try {
    const parsed = new URL(`https://${normalized}`);
    return parsed.hostname === normalized && !parsed.port
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function getCookieDomain(requestOrigin?: string | null) {
  const value = String(COOKIE_DOMAIN ?? "").trim();
  if (!value) return null;

  const hasRequestOrigin = Boolean(String(requestOrigin ?? "").trim());
  if (!hasRequestOrigin) return value;

  const requestHostname = getSecureOriginHostname(requestOrigin);
  const cookieHostname = normalizeCookieDomainForComparison(value);
  if (!requestHostname || !cookieHostname) return null;

  const belongsToCookieDomain =
    requestHostname === cookieHostname ||
    requestHostname.endsWith(`.${cookieHostname}`);

  return belongsToCookieDomain ? value : null;
}

export function getAuthCookieName() {
  return AUTH_COOKIE_NAME;
}

export function getBrandAuthCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Host-pingo_brand_token"
    : "pingo_brand_token";
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
  const scope = requestCookieScope(headers);
  if (scope === "INVALID") return null;
  if (scope === "BRAND") {
    return cookies[getBrandAuthCookieName()] ?? null;
  }
  if (scope === "STANDARD") {
    return cookies[getAuthCookieName()] ?? null;
  }

  return (
    cookies[getBrandAuthCookieName()] ??
    cookies[getAuthCookieName()] ??
    null
  );
}

export function buildAuthCookie(
  token: string,
  options: AuthCookieOptions = {}
) {
  const isProd = process.env.NODE_ENV === "production";
  const sameSite = isProd ? "None" : "Lax";
  const cookieScope = cookieScopeForOrigin(options.requestOrigin);
  const cookieDomain =
    cookieScope === "STANDARD"
      ? getCookieDomain(options.requestOrigin)
      : null;
  const cookieName =
    cookieScope === "BRAND"
      ? getBrandAuthCookieName()
      : getAuthCookieName();

  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
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

export function buildClearAuthCookie(
  options: AuthCookieOptions = {}
) {
  const isProd = process.env.NODE_ENV === "production";
  const sameSite = isProd ? "None" : "Lax";
  const cookieScope = cookieScopeForOrigin(options.requestOrigin);
  const cookieDomain =
    cookieScope === "STANDARD"
      ? getCookieDomain(options.requestOrigin)
      : null;
  const cookieName =
    cookieScope === "BRAND"
      ? getBrandAuthCookieName()
      : getAuthCookieName();

  const parts = [
    `${cookieName}=`,
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
