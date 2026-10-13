import type { PrismaClient } from "@prisma/client";
import {
  parseBoundLiveSidebandEvent, noteLiveUsage, finalizeLiveClosed,
} from "./sales-voice-live-watchdog.service.js";

// ISOLATED AND UNMOUNTED: only a signed, previously persisted Live SIP call
// may be monitored. This module never sends audio, tools, session.start,
// session.close, provider hangup, or outbound communications.
// Opening authenticated transport is injected, never automatic.
export class SalesSidebandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesSidebandError";
  }
}
const reject = (code: string): never => { throw new SalesSidebandError(code); };

export function liveSidebandAttachUrl(sessionId: string): string {
  if (typeof sessionId !== "string" || !/^live_[a-zA-Z0-9_-]{1,123}$/.test(sessionId)) {
    reject("INVALID_LIVE_SESSION_ID");
  }
  return "wss://api.openai.com/v1/live/sessions/" + encodeURIComponent(sessionId) + "/attach";
}

export type SidebandWebSocket = {
  on: (event: "open" | "message" | "close" | "error",
    cb: (...args: unknown[]) => void) => unknown;
  close: (code?: number, reason?: string) => void;
};
export type SidebandSocketFactory = (url: string, options: {
  headers: { Authorization: string };
  handshakeTimeout: number;
  maxPayload: number;
  perMessageDeflate: false;
}) => SidebandWebSocket;
type Db = Pick<PrismaClient, "salesVoiceCall">;

export type SidebandSessionResult =
  | { state: "CONFIRMED_CLOSED"; sessionId: string; eventCount: number }
  | { state: "UNCONFIRMED_DISCONNECT"; sessionId: string; eventCount: number }
  | { state: "AUTHENTICATION_MISMATCH"; sessionId: string; eventCount: number }
  | { state: "PROCESSING_ERROR"; sessionId: string; eventCount: number };

/**
 * WebSocket authentication must come from a server-only project API key.
 * This function attaches solely to an already-existing SIP session.
 * Expects a Node ws-compatible socket factory. No factory ships in this PR,
 * so a separate dependency + live interoperability test is required.
 */
export async function observeExistingLiveSession(input: {
  db: Db;
  sessionId: string;
  apiKey: string;
  enabled: boolean;
  connect: SidebandSocketFactory;
  onObservation?: (kind: "usage" | "closed") => void;
}): Promise<{
  completion: Promise<SidebandSessionResult>;
  disconnect: () => void;
}> {
  const url = liveSidebandAttachUrl(input.sessionId);
  if (!input.enabled) reject("SUPERVISOR_DISABLED");
  if (!input.apiKey || !input.apiKey.startsWith("sk-")) reject("API_KEY_REQUIRED");
  if (typeof input.connect !== "function") reject("TRANSPORT_FACTORY_REQUIRED");
  const row = await input.db.salesVoiceCall.findUnique({ where: { providerCallId: input.sessionId } });
  const allowed = new Set([
    "ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN",
    "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN",
  ]);
  if (!row || row.provider !== "OPENAI_LIVE_SIP" || row.direction !== "INBOUND"
      || row.finalizedAt || !allowed.has(row.status)) {
    reject("VERIFIED_ACTIVE_LIVE_CALL_REQUIRED");
  }

  const socket = input.connect(url, {
    headers: { Authorization: "Bearer " + input.apiKey },
    handshakeTimeout: 5000,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  if (!socket || typeof socket.on !== "function" || typeof socket.close !== "function") {
    reject("INVALID_SOCKET");
  }
  // WSS authentication and the selected live_ session URL are the binding.
  // A secondary attach may occur after session.started; that event is optional.
  let authenticatedTransport = false;
  let terminal: SidebandSessionResult["state"] | null = null;
  let count = 0;
  let chained = Promise.resolve();
  let finish!: (value: SidebandSessionResult) => void;
  const completion = new Promise<SidebandSessionResult>(resolve => { finish = resolve; });
  const settle = (state: SidebandSessionResult["state"]) => {
    if (terminal) return;
    terminal = state;
    finish({ state, sessionId: input.sessionId, eventCount: count });
    try { socket.close(); } catch { /* preserve state; never treat close as finalization */ }
  };

  socket.on("open", () => { if (!terminal) authenticatedTransport = true; });
  socket.on("message", (raw: unknown) => {
    if (terminal) return;
    // Serialize DB work to preserve causal order under bursts of messages.
    chained = chained.then(async () => {
      if (terminal) return;
      const data = typeof raw === "string" ? raw :
        Buffer.isBuffer(raw) ? raw.toString("utf8") : null;
      if (data === null || Buffer.byteLength(data, "utf8") > 16 * 1024) {
        settle("PROCESSING_ERROR"); return;
      }
      let event: unknown;
      try { event = JSON.parse(data); }
      catch { settle("PROCESSING_ERROR"); return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        settle("PROCESSING_ERROR"); return;
      }
      const obj = event as Record<string, unknown>;
      // No provider event may modify state before a successful authenticated
      // WSS upgrade, even if a mock transport delivers data prematurely.
      if (!authenticatedTransport) { settle("AUTHENTICATION_MISMATCH"); return; }
      // If any server event carries its canonical session ID, verify it.
      // Usage events may omit that field: their scope is the authenticated
      // WSS connection to the exact session URL.
      if ("session_id" in obj && obj.session_id !== input.sessionId) {
        settle("AUTHENTICATION_MISMATCH"); return;
      }
      if (obj.type === "session.started") {
        const session = obj.session;
        if (!session || typeof session !== "object" || Array.isArray(session)
            || (session as Record<string, unknown>).id !== input.sessionId) {
          settle("AUTHENTICATION_MISMATCH"); return;
        }
        return;
      }
      if (obj.type !== "session.usage.updated" && obj.type !== "session.closed") return;
      try {
        const parsed = parseBoundLiveSidebandEvent(obj, input.sessionId);
        if (!parsed) return;
        count++;
        if (parsed.type === "usage") {
          await noteLiveUsage(input.db, parsed);
          input.onObservation?.("usage");
        } else {
          await finalizeLiveClosed(input.db, parsed);
          input.onObservation?.("closed");
          settle("CONFIRMED_CLOSED");
        }
      } catch {
        settle("PROCESSING_ERROR");
      }
    }).catch(() => settle("PROCESSING_ERROR"));
  });
  socket.on("close", () => {
    void chained.finally(() => { if (!terminal) settle("UNCONFIRMED_DISCONNECT"); });
  });
  socket.on("error", () => {
    void chained.finally(() => { if (!terminal) settle("UNCONFIRMED_DISCONNECT"); });
  });
  // Never send session.start on an existing SIP sideband.
  return {
    completion,
    disconnect: () => settle("UNCONFIRMED_DISCONNECT"),
  };
}
