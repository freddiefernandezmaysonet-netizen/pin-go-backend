import jwt from "jsonwebtoken";
import {
  signAuthToken,
  verifyAuthToken,
  type AuthTokenPayload,
} from "../lib/auth.js";

export type SessionBoundAuthTokenPayload = AuthTokenPayload & {
  sid?: string;
};

export function signSessionBoundAuthToken(
  payload: AuthTokenPayload,
  sessionId?: string | null
): string {
  const sid = String(sessionId ?? "").trim();
  const signedPayload: SessionBoundAuthTokenPayload = sid
    ? { ...payload, sid }
    : payload;

  return signAuthToken(signedPayload as AuthTokenPayload);
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
  return sid ? { ...verified, sid } : verified;
}
