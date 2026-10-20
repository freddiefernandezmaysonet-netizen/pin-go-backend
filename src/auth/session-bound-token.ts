import jwt from "jsonwebtoken";
import { hostCredentialLifetimeSeconds, isRollingHostPolicy, type HostSessionPolicy } from "./host-session.policy.js";
import {
  signAuthToken,
  verifyAuthToken,
  type AuthTokenPayload,
} from "../lib/auth.js";

export type SessionBoundAuthTokenPayload = AuthTokenPayload & {
  sid?: string;
  sp?: HostSessionPolicy;
  exp?: number;
};

export function signSessionBoundAuthToken(
  payload: AuthTokenPayload,
  sessionId?: string | null,
  policy: HostSessionPolicy = "LEGACY"
): string {
  const sid = String(sessionId ?? "").trim();
  const signedPayload: SessionBoundAuthTokenPayload = sid
    ? { ...payload, sid, ...(isRollingHostPolicy(policy) ? { sp: policy } : {}) }
    : payload;

  return signAuthToken(signedPayload as AuthTokenPayload, sid ? hostCredentialLifetimeSeconds(policy) : undefined);
}

export function verifySessionBoundAuthToken(
  token: string
): SessionBoundAuthTokenPayload {
  const verified = verifyAuthToken(token);
  const decoded = jwt.decode(token);

  if (!decoded || typeof decoded === "string") {
    return verified;
  }

  const sid = typeof decoded.sid === "string" ? decoded.sid.trim() : "";
  const sp = isRollingHostPolicy(decoded.sp) ? decoded.sp : undefined;
  return sid ? { ...verified, sid, ...(sp ? { sp } : {}), ...(typeof decoded.exp === "number" ? { exp: decoded.exp } : {}) } : verified;
}
