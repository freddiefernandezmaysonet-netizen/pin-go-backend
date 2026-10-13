/**
 * Pure, fail-closed reconciliation policy for previously verified Live SIP
 * sessions. No provider API is assumed to support state retrieval.
 * This module performs no database writes, HTTP, WebSocket or hangup.
 *
 * External evidence is deliberately restricted to a sideband event from an
 * authenticated, session-bound transport. Generic HTTP 200, socket close,
 * provider timeouts and absence of records are never closure proof.
 */
export type RecoveryDecision =
  | "NO_ACTION"
  | "REQUIRE_PROVIDER_REVIEW"
  | "KEEP_CAPACITY_HELD"
  | "HAND_OFF_SIGNED_CLOSE_TO_FINALIZER";

export type SessionEvidence =
  | {kind:"NONE"}
  | {kind:"PROVIDER_HTTP_ACCEPTED"}
  | {kind:"SOCKET_DISCONNECTED"}
  | {kind:"HANGUP_HTTP_ACKNOWLEDGED"}
  | {kind:"SIGNED_BOUND_SESSION_CLOSED";sessionId:string;eventSessionId:string;usageSeconds:number};

const held = new Set([
  "ADMISSION_CLAIMED","ACCEPTED","ACCEPT_UNKNOWN",
  "HANGUP_CLAIMED","HANGUP_SENT","HANGUP_UNKNOWN",
]);
const idValid = (s:unknown):s is string =>
  typeof s==="string" && /^live_[A-Za-z0-9_-]{1,123}$/.test(s);

export function decideSalesVoiceRecovery(input:{
  sessionId:string|null;
  provider:string;
  direction:string;
  status:string;
  finalized:boolean;
  evidence:SessionEvidence;
}):RecoveryDecision {
  if(input.finalized || input.status==="COMPLETED") return "NO_ACTION";
  if(input.provider!=="OPENAI_LIVE_SIP" || input.direction!=="INBOUND"
    || !idValid(input.sessionId)) return "REQUIRE_PROVIDER_REVIEW";
  if(!held.has(input.status)) return "NO_ACTION";

  const e=input.evidence;
  if(e.kind==="SIGNED_BOUND_SESSION_CLOSED") {
    if(e.sessionId!==input.sessionId || e.eventSessionId!==input.sessionId
      || !Number.isFinite(e.usageSeconds) || e.usageSeconds<0
      || e.usageSeconds>604800) return "REQUIRE_PROVIDER_REVIEW";
    // Never finalize here. The existing watchdog finalizer validates
    // session binding, monotonic usage and atomic closure independently.
    return "HAND_OFF_SIGNED_CLOSE_TO_FINALIZER";
  }
  if(input.status==="ACCEPT_UNKNOWN" || input.status==="HANGUP_UNKNOWN"
    || input.status==="ADMISSION_CLAIMED" || input.status==="HANGUP_CLAIMED") {
    return "REQUIRE_PROVIDER_REVIEW";
  }
  return "KEEP_CAPACITY_HELD";
}
