import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { GuestPinAIActionProposalResponse } from "./guest-runtime-gateway.js";
import type { PinAIActionBrokerExecuteResult } from "../actions/action-broker.service.js";

export type GuestHistoryMessage = {
  id: string;
  role: "guest" | "assistant";
  text: string;
  requiresHumanReview?: boolean;
  actionProposal?: GuestPinAIActionProposalResponse;
  actionResult?: PinAIActionBrokerExecuteResult;
};
const MAX_BYTES = 160_000;
type Scope = Readonly<{ reservationId: string; guestToken: string }>;

// Encrypt dialogue and guest-only credentials with a domain-separated key bound
// to this reservation's bearer token. This is not protection from a DB reader
// who also has the reservation guestToken. Never log payloads or encryption keys.
function key(scope: Scope) {
  return createHash("sha256").update(JSON.stringify(["pin-ai-guest-history-v1", scope.reservationId, scope.guestToken])).digest();
}

export function sealGuestHistory(scope: Scope, kind: "messages" | "receipts", value: unknown): string {
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > MAX_BYTES) throw new Error("PIN_AI_HISTORY_TOO_LARGE");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(scope), iv);
  cipher.setAAD(Buffer.from(kind));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function openGuestHistory<T>(scope: Scope, kind: "messages" | "receipts", ciphertext: string): T {
  try {
    if (ciphertext.length > MAX_BYTES * 2) throw new Error();
    const envelope = JSON.parse(ciphertext);
    if (envelope.v !== 1) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(scope), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    decipher.setAAD(Buffer.from(kind));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    if (plain.length > MAX_BYTES) throw new Error();
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
  }
}

export function readGuestMessages(scope: Scope, ciphertext: string | null | undefined): GuestHistoryMessage[] {
  if (!ciphertext) return [];
  const messages = openGuestHistory<GuestHistoryMessage[]>(scope, "messages", ciphertext);
  if (!Array.isArray(messages) || messages.length > 40 || messages.some(m =>
    !m || typeof m.id !== "string" || !["guest", "assistant"].includes(m.role) ||
    typeof m.text !== "string" || m.text.length > 32_000 ||
    (m.actionProposal && (m.role !== "assistant" || m.actionProposal.actionType !== "RESERVATION_MODIFICATION")))) {
    throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
  }
  return messages;
}

export function appendGuestMessages(scope: Scope, previous: GuestHistoryMessage[], pair: GuestHistoryMessage[]): string {
  const messages = [...previous, ...pair].slice(-40);
  while (Buffer.byteLength(JSON.stringify(messages)) > MAX_BYTES && messages.length > pair.length) messages.shift();
  return sealGuestHistory(scope, "messages", messages);
}

// Separate column: confirmations never race with the runtime's conversation
// lease or overwrite dialogue. CAS retries serialize simultaneous confirmations.
export async function saveGuestActionReceipt(prisma: Pick<PrismaClient, "pinAIGuestConversation">, scope: Scope, receipt: PinAIActionBrokerExecuteResult): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await prisma.pinAIGuestConversation.findUnique({ where: { reservationId: scope.reservationId }, select: { guestActionReceiptsCiphertext: true } });
    if (!row) throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
    const prior = row.guestActionReceiptsCiphertext ?? null;
    const receipts = prior ? openGuestHistory<PinAIActionBrokerExecuteResult[]>(scope, "receipts", prior) : [];
    if (!Array.isArray(receipts) || receipts.length > 20) throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
    const next = [...receipts.filter(r => r.proposalId !== receipt.proposalId), receipt].slice(-20);
    const updated = await prisma.pinAIGuestConversation.updateMany({
      where: { reservationId: scope.reservationId, guestActionReceiptsCiphertext: prior },
      data: { guestActionReceiptsCiphertext: sealGuestHistory(scope, "receipts", next) },
    });
    if (updated.count === 1) return;
  }
  throw new Error("PIN_AI_HISTORY_UNAVAILABLE");
}
