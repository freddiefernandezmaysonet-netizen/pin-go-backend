import { createRequire } from "node:module";
import type {
  SidebandSocketFactory,
  SidebandWebSocket,
} from "./sales-voice-sideband-supervisor.service.js";

// Isolated transport adapter. No entrypoint invokes it, and it never
// creates/accepts a SIP call. The official server sideband uses HTTP Upgrade
// with Authorization from a trusted backend over wss://.
// No WebSocket redirects, compression or custom request host allowed.
export class SalesSidebandTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesSidebandTransportError";
  }
}
const fail = (code: string): never => { throw new SalesSidebandTransportError(code); };

type WsOptions = {
  headers: { Authorization: string };
  handshakeTimeout: number;
  maxPayload: number;
  perMessageDeflate: false;
  followRedirects: false;
  rejectUnauthorized: true;
  maxRedirects: 0;
  protocolVersion: 13;
};
type WsConstructor = new (url: string, options: WsOptions) => SidebandWebSocket;

function validAddress(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "wss:"
      && u.hostname === "api.openai.com"
      && u.port === "" && u.username === "" && u.password === ""
      && u.search === "" && u.hash === ""
      && /^\/v1\/live\/sessions\/live_[a-zA-Z0-9_-]{1,123}\/attach$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Real, pinned 'ws' implementation (exact package version from lockfile).
 * Optional test constructor only captures connection arguments and never
 * changes target origin or authorization validation.
 */
export function createOpenAISidebandWsFactory(testConstructor?: WsConstructor): SidebandSocketFactory {
  const build: WsConstructor = testConstructor ?? (
    createRequire(import.meta.url)("ws") as WsConstructor
  );
  if (typeof build !== "function") fail("INVALID_WEBSOCKET_IMPLEMENTATION");

  return (url, input) => {
    if (!validAddress(url)) fail("INVALID_PROVIDER_ENDPOINT");
    const token = input?.headers?.Authorization;
    if (typeof token !== "string" || !/^Bearer sk-[A-Za-z0-9_-]{3,300}$/.test(token)) {
      fail("INVALID_PROVIDER_AUTHORIZATION");
    }
    if (input.handshakeTimeout !== 5000
      || input.maxPayload !== 16 * 1024
      || input.perMessageDeflate !== false) {
      fail("UNSAFE_WEBSOCKET_SETTINGS");
    }
    return new build(url, {
      headers: { Authorization: token },
      handshakeTimeout: 5000,
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
      rejectUnauthorized: true,
      maxRedirects: 0,
      protocolVersion: 13,
    });
  };
}
