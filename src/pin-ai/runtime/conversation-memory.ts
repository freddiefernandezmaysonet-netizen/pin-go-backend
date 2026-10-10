import type {
  PinAIConversationMessage,
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";

export type PinAIConversationIssueState =
  | "OPEN"
  | "RESOLVED"
  | "ESCALATED"
  | "WAITING";

export type PinAIConversationIssue = Readonly<{
  key: string;
  state: PinAIConversationIssueState;
  summary: string;
  lastUpdatedAt: string;
}>;

export type PinAIConversationMemory = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  guestId: string;
  preferredLanguage?: "en" | "es";
  facts: Readonly<Record<string, unknown>>;
  issues: readonly PinAIConversationIssue[];
  attemptedTroubleshooting: readonly string[];
  completedToolChecks: readonly PinAIRuntimeToolName[];
}>;

export function createConversationMemory(
  request: PinAIRuntimeRequest,
): PinAIConversationMemory {
  return {
    organizationId: request.context.organizationId,
    propertyId: request.context.propertyId,
    reservationId: request.context.reservationId,
    guestId: request.context.guestId,
    ...(request.context.preferredLanguage !== undefined ? { preferredLanguage: request.context.preferredLanguage } : {}),
    // Conversation interpretation belongs to the model. Do not synthesize facts
    // or performed attempts from isolated keywords or assistant suggestions.
    facts: {},
    issues: [],
    attemptedTroubleshooting: [],
    completedToolChecks: [],
  };
}

export function assertMemoryMatchesRequest(
  memory: PinAIConversationMemory,
  request: PinAIRuntimeRequest,
): void {
  const pairs: readonly [string, string][] = [
    [memory.organizationId, request.context.organizationId],
    [memory.propertyId, request.context.propertyId],
    [memory.reservationId, request.context.reservationId],
    [memory.guestId, request.context.guestId],
  ];

  if (pairs.some(([memoryValue, requestValue]) => memoryValue !== requestValue)) {
    throw new Error("PIN_AI_RUNTIME_MEMORY_SCOPE_MISMATCH");
  }
}

